import { MembershipCache } from "./membership-cache";
import { AppServiceBot } from "./app-service-bot";
import { WeakEvent } from "./event-types";
import { Intent } from "./intent";
import Logging from "./logging";
import { MatrixClient } from "matrix-bot-sdk";
import LRU from "@alloc/quick-lru"

const log = Logging.get("EncryptedEventBroker");

export const APPSERVICE_LOGIN_TYPE = "uk.half-shot.msc2778.login.application_service";
const EVENT_CACHE_FOR_MS = 5 * 60000; // 5 minutes

interface PanWeakEvent extends WeakEvent {
    decrypted: true;
}

export interface ClientEncryptionSession {
    userId: string;
    deviceId: string;
    accessToken: string;
    syncToken: string|null;
}
export interface ClientEncryptionStore {
    getStoredSession(userId: string): Promise<ClientEncryptionSession|null>;
    setStoredSession(session: ClientEncryptionSession): Promise<void>;
    updateSyncToken(userId: string, token: string): Promise<void>;
}

const SYNC_FILTER = {
    room: {
        include_leave: false,
        state: {
            types: ["a.invalid.type.because.empty.means.all.types"],
            limit: 0,
        },
        timeline: {
            types: ["m.room.encrypted"],
            // To reduce load, ideally we wouldn't care at all.
            lazy_load_members: true,
        },
        account_data: {
            limit: 0,
        },
        ephemeral: {
            // No way to disable presence, so make it filter for an impossible type
            types: ["not.a.real.type"],
            limit: 0,
        }
    },
    presence: {
        // No way to disable presence, so make it filter for an impossible type
        types: ["not.a.real.type"],
        limit: 0,
    }
};

interface SyncingUser {
    matrixClient: MatrixClient;
    state: "preparing"|"syncing";
    preparingPromise: Promise<unknown>;
}

/**
 * The EncryptedEventBroker ensures that we provide a single encrypted
 * event to bridges from potentially multiple /sync responses. The broker
 * is also responsible for starting these syncs depending on which users
 * can read the room.
 *
 * More broadly speaking, the bridge handles encrypted events currently by
 * listening over the AS stream for encrypted messages, and then spinning
 * up a /sync in order to read the message. In order to decrypt them, we
 * proxy these requests through https://github.com/matrix-org/pantalaimon.
 *
 *   +-------------------+
 *   |  Homeserver       |
 *   +--------+----------+
 *           ^
 *           | Proxy
 *           |
 *           |
 *   +--------+----------+
 *   |  Pantalaimon      |
 *   +--------+----------+
 *           ^ /sync requests
 *           |
 *           |
 *   +--------+----------+
 *   |  Bridge           |
 *   +-------------------+
 *
 */
export class EncryptedEventBroker {
    constructor(
        private membership: MembershipCache,
        private asBot: AppServiceBot,
        private onEvent: (weakEvent: WeakEvent) => void,
        private getIntent: (userId: string) => Intent,
        private store: ClientEncryptionStore,
        ) {

    }
    private handledEvents = new LRU<string, void>({ maxAge: EVENT_CACHE_FOR_MS, maxSize: 10000 });
    private userForRoom = new Map<string, string>();

    private eventsPendingSync = new Set<string>();
    // We should probably make these LRUs eventually
    private eventsPendingAS: WeakEvent[] = [];

    private syncingClients = new Map<string, SyncingUser>();

    /**
     * Called when the bridge gets an event through an appservice transaction.
     * @param event
     * @returns Should the event be passed through to the bridge.
     */
    public async onASEvent(event: WeakEvent): Promise<boolean> {
        if (event.type === "m.room.member" && event.state_key && event.content.membership) {
            const existingSyncUser = this.userForRoom.get(event.room_id);
            if (existingSyncUser === event.state_key && event.content.membership !== "join") {
                // User has left the room (or are banned/invited), they are no longer our sync targets.
                this.userForRoom.delete(event.room_id);
            }
        }

        if (event.type !== "m.room.encrypted") {
            log.debug(`Ignoring ${event.event_id}, not a encrypted event`);
            // Passthrough directly.
            return true;
        }

        log.debug(`Got AS event ${event.event_id}`);
        this.eventsPendingSync.add(event.event_id);
        const syncedEvent = this.eventsPendingAS.find((syncEvent) => syncEvent.event_id === event.event_id);
        if (syncedEvent) {
            log.debug("Got sync event before AS event");
            this.handleEvent(syncedEvent);
            return false;
        }

        // We need to determine if anyone is syncing for this room?
        const existingUserForRoom = this.userForRoom.get(event.room_id);
        if (existingUserForRoom) {
            log.debug(`${existingUserForRoom} is listening for ${event.event_id}`);
            // XXX: Sometimes the sync stops working, calling this will wake it up.
            await this.startSyncingUser(existingUserForRoom);
            return false;
        }

        // Do we have any clients in these rooms already.
        let fullRoomMembership = this.membership.getMembersForRoom(event.room_id, "join");
        if (!fullRoomMembership) {
            log.info(`${event.room_id} has no room membership cached`);
            // We have no membership for this room, fetch it.
            await this.asBot.getJoinedMembers(event.room_id);
            // The cache is populated
            fullRoomMembership = this.membership.getMembersForRoom(event.room_id, "join");
            if (!fullRoomMembership) {
                log.error(`${event.room_id} has NO membership after trying to fetch fresh state`);
                // We STILL don't have membership? Doesn't seem likely.
                return false;
            }
        }

        const membersForRoom = fullRoomMembership.filter((u) => this.asBot.isRemoteUser(u));
        if (!membersForRoom.length) {
            log.error(`${event.room_id} has no bridge users in the room`);
            // We have NO clients in this room but we got the event? Seems dodgy.
            return false;
        }

        const existingUser = membersForRoom.find((u) => [...this.userForRoom.values()].includes(u));
        if (existingUser) {
            log.debug(`${event.room_id} will be synced by ${existingUser}`);
            // Bind them to the room
            this.userForRoom.set(event.room_id, existingUser);
        }

        // We have no syncing clients for this room. Take the first one.
        const newSyncer = membersForRoom[0];
        log.debug(`No syncing clients for ${event.room_id}, will use ${newSyncer}`);
        // Wait so that we block before new events arrive.
        await this.getIntent(newSyncer).ensureRegistered();
        await this.startSyncingUser(newSyncer);
        this.userForRoom.set(event.room_id, newSyncer);
        return false;
    }

    private onSyncEvent(roomId: string, event: PanWeakEvent): void {
        if (!event.decrypted) {
            // We only care about encrypted events, and pan appends a decrypted key to each event.
            return;
        }
        // TODO: Do we need this?
        event.room_id = roomId;
        if (!this.eventsPendingSync.has(event.event_id)) {
            log.debug("Got AS event before sync event");
            // We weren't waiting for this event, but we might have got here too quick.
            this.eventsPendingAS.push(event);
            return;
        }
        const key = `${roomId}}:${event.event_id}`;
        if (this.handledEvents.has(key)) {
            // We're not interested in this event, as it's been handled.
            return;
        }
        this.handleEvent(event);
    }

    private handleEvent(event: WeakEvent) {
        // First come, first serve handling.
        this.handledEvents.set(`${event.room_id}:${event.event_id}`);

        log.debug(`Handling ${event.event_id} through sync`);
        this.onEvent(event);

        // Delete the event from the pending list
        this.eventsPendingSync.delete(event.event_id);
        this.eventsPendingAS = this.eventsPendingAS.filter((e) => e.event_id !== event.event_id);
    }

    private async onSync(userId: string, state: string, data: {nextSyncToken: string; catchingUp: boolean;}) {
        log.debug(`${userId} sync is ${state}`);
        if ((state === "SYNCING" || state === "PREPARED") && data.nextSyncToken) {
            await this.store.updateSyncToken(userId, data.nextSyncToken);
        }
    }

    /**
     * Start a sync loop for a given bridge user
     * @param userId The user whos matrix client should start syncing
     * @returns Resolves when the sync has begun.
     */
    public async startSyncingUser(userId: string): Promise<void> {
        const existingState = this.syncingClients.get(userId);
        if (existingState?.state === "syncing") {
            log.debug(`Client is already syncing`);
            // No-op, already running
            return;
        }
        const intent = this.getIntent(userId);
        const { matrixClient } = intent;

        const preparingPromise = matrixClient.start(SYNC_FILTER);
        log.debug(`Starting to sync ${userId}`)
        this.syncingClients.set(userId, {
            preparingPromise,
            state: "preparing",
            matrixClient: matrixClient,
        });

        // Wrenching into the bot sdk to pull the token out.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        matrixClient.storageProvider.setSyncToken = async (token) => {
            if (token) {
                await this.store.updateSyncToken(userId, token);
            }
        };

        // Bind handlers
        matrixClient.on('room.event', this.onSyncEvent.bind(this));

        try {
            await preparingPromise;
            this.syncingClients.set(userId, {
                preparingPromise: Promise.resolve(),
                state: "syncing",
                matrixClient: matrixClient,
            });
        }
        catch (ex) {
            log.error(`Failed to start sync for ${userId}: `, ex);
            this.syncingClients.delete(userId);
            throw Error(`Failed to start a sync loop for ${userId}`);
        }

        log.debug(`Starting a new sync for ${userId}`);
    }

    public shouldAvoidCull(intent: Intent): boolean {
        // Is user in use for syncing a room?
        if ([...this.userForRoom.values()].includes(intent.userId)) {
            return true;
        }

        const clientSet = this.syncingClients.get(intent.userId);
        // Otherwise, we should cull it. Also stop it from syncing.
        if (clientSet) {
            log.debug(`Stopping sync for ${intent.userId} due to cull`);
            // If we ARE culling the client then ensure they stop syncing too.
            try {
                this.syncingClients.delete(intent.userId);
                if (clientSet.state !== "syncing") {
                    log.warn(`Culling client ${intent.userId} but they have not started syncing yet`);
                    clientSet.preparingPromise.catch(() => {
                        log.warn(`Could not stop preparing client (${intent.userId}) from syncing`);
                    }).finally(() => {
                        clientSet.matrixClient.stop();
                    })
                }
                else {
                    clientSet.matrixClient.stop();
                }
                // Delete regardless.
            }
            catch (ex) {
                log.debug(`Failed to cull ${intent.userId}`, ex);
            }
        }
        return false;
    }

    /**
     * Stop syncing clients used for encryption
     */
    public close(): void {
        for (const client of this.syncingClients.values()) {
            client.matrixClient.stop();
        }
    }

    public static supportsLoginFlow(loginFlows: {flows: {type: string}[]}): boolean {
        return loginFlows.flows.find(
            flow => flow.type === APPSERVICE_LOGIN_TYPE
        ) !== undefined;
    }
}
