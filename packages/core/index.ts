export interface EventShape {
  readonly type: string,
  readonly version: number,
  readonly identifier: string,
  readonly date: Date,
  readonly data: Record<string, unknown>
}

export class CorruptionError extends Error {
  public override readonly name = "CorruptionError";

  public constructor(public readonly errors: Error[]) {
    super();
  }
}

export class TransactionError extends Error {
  public override readonly name = "TransactionError";

  public constructor(public readonly error: Error) {
    super();
  }
}

export type Replay<State, Event> = (previousState: State, event: Event) => State

export type Subscriber = () => void;

export type UnsubscribeFunction = () => void

export type SubscribeFunction = (subscriber: Subscriber) => UnsubscribeFunction

export type TransactionCommitFunction = () => Promise<void>;

export type TransactionRollbackFunction = () => void;

export interface TransactionCallbackOptions {
  readonly commit: TransactionCommitFunction
  readonly rollback: TransactionRollbackFunction
}

export type TransactionCallbackFunction = (options: TransactionCallbackOptions) => Promise<void>

export type TransactionFunction = (callback: TransactionCallbackFunction) => Promise<TransactionError | null>

export interface EventStore<State, Event> {
  readonly saveEvent: (event: Event) => Promise<null | Error>;
  readonly getEvents: () => Promise<ReadonlyArray<Event> | CorruptionError>;
  readonly getState: () => Promise<Readonly<State>>;
  readonly subscribe: SubscribeFunction;
  readonly initialize: InitializeFunction;
  readonly transaction: TransactionFunction
}

export type ReleaseLockFunction = () => void;

export interface EventAdapter<Event> {
  readonly save: (event: Event) => Promise<void>
  readonly retrieve: () => Promise<unknown[]>
}

export type EventStoreParser<Event> = (event: unknown) => Event | Error

export type InitializeFunction = () => Promise<null | CorruptionError>

export interface CreateEventStoreOptions<State, Event> {
  readonly state: State,
  readonly parser: EventStoreParser<Event>,
  readonly eventAdapter: EventAdapter<Event>,
  readonly replay: Replay<State, Event>,
}

export function createEventStore<State, Event extends EventShape>(options: CreateEventStoreOptions<State, Event>): EventStore<State, Event> {
  const subscribers: Subscriber[] = [];
  const uncommitedEvents: Event[] = [];

  let state: State = options.state;
  let events: Event[] = [];
  let inTransaction: boolean = false;
  let lock: Promise<void> | null = null;

  async function requestLock() {
    let releaseLock: ReleaseLockFunction = () => { };

    if (lock instanceof Promise) {
      await lock;
    }

    lock = new Promise<void>(resolve => {
      releaseLock = resolve
    });

    return releaseLock;
  }

  async function saveEvent(event: Event): Promise<null | Error> {
    if (inTransaction) {
      console.log("In transaction");
      uncommitedEvents.push(event);
      return null;
    }

    const releaseLock = await requestLock();

    try {

      state = options.replay(state, event);
      await options.eventAdapter.save(event);

      subscribers.forEach(notify => {
        notify();
      });

      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      releaseLock();
    }
  }

  async function initialize(): Promise<null | CorruptionError> {
    const releaseLock = await requestLock();

    try {
      const receivedEvents: unknown[] = await options.eventAdapter.retrieve();
      const parsedEvents: Event[] = [];

      if (receivedEvents instanceof Error) {
        return new CorruptionError([receivedEvents]);
      }

      for (const event of receivedEvents) {
        const parsedEvent = options.parser(event);

        if (parsedEvent instanceof Error) {
          return new CorruptionError([parsedEvent]);
        }

        parsedEvents.push(parsedEvent);
        state = options.replay(state, parsedEvent);
      }

      return null;

    } catch (error) {
      return error instanceof Error ? new CorruptionError([error]) : new CorruptionError([new Error(String(error))]);
    } finally {
      releaseLock();
    }
  }

  function getState(): Promise<Readonly<State>> {
    return options.stateAdapter.retrieve();
  }

  async function getEvents(): Promise<ReadonlyArray<Event> | CorruptionError> {
    const unparsedEvents: unknown[] = await options.eventAdapter.retrieve();
    const parsedEvents: Event[] = [];

    for (const event of unparsedEvents) {
      const parsedEvent = options.parser(event);

      if (parsedEvent instanceof Error) {
        return new CorruptionError([parsedEvent]);
      }

      parsedEvents.push(parsedEvent);
    }

    return parsedEvents;
  }

  function subscribe(newSubscriber: Subscriber): UnsubscribeFunction {
    subscribers.push(newSubscriber);

    return () => {
      const subscriberIndex = subscribers.findIndex(subscriber => {
        return subscriber === newSubscriber;
      });

      if (subscriberIndex !== -1) {
        subscribers.splice(subscriberIndex, 1);
      }
    }
  }

  async function transaction(callback: TransactionCallbackFunction): Promise<TransactionError | null> {
    inTransaction = true;

    function rollback(): void {
      uncommitedEvents.length = 0;
    }

    async function commit(): Promise<void> {
      while (uncommitedEvents.length > 0) {
        console.log("DEBUG: commiting event...");

        const uncommitedEvent = uncommitedEvents[0];

        await options.adapter.save(uncommitedEvent);

        state = options.replay(state, uncommitedEvent);

        events.push(uncommitedEvent);

        uncommitedEvents.splice(0, 1);
      }

      subscribers.forEach(notify => {
        notify();
      });
    }

    const releaseLock = await requestLock();

    try {
      await callback({
        commit,
        rollback
      });

      return null;
    } catch (error) {
      rollback();
      return new TransactionError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      inTransaction = false;
      releaseLock();
    }
  }

  return {
    saveEvent,
    getState,
    getEvents,
    subscribe,
    initialize,
    transaction
  }
}