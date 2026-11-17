// R1-B1 (B10 section 3 rule 1): the Engine -> bot receiver. Express on 127.0.0.1:BOT_PORT.
//
//   POST /v1/events   linkAuth (bearer, loopback Host on this port, no browser markers, JSON, 32 KB strict parser)
//                     -> validateEngineToBot(body, now)          400 / 409 Nack { ok:false, code, reason }
//                     -> inbox dedup on event_id (48 h, persisted)
//                     -> 202 { ok:true, event_id, duplicate, received_at } BEFORE any side effect (the Engine's dispatcher must never wait
//                        for the bot's trading or Telegram work; target < 50 ms)
//                     -> the event is handed to intake on the next tick; a duplicate does nothing else.
// The old /signal route does not exist here (R4-B6 removes it from bot.ts). Everything else under /v1 is a JSON 404 behind the same auth.
// R7-W6 (A-99): an optional wallet router answers POST /v1/wallet/{quote,fill,find,balances,close-quote,close-fill} synchronously behind that auth.
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Ack, EngineToBotEvent, Nack } from '../shared/contract/v1';
import { signalDetailDropped, validateEngineToBot } from '../shared/contract/validate';
import { linkAuth } from '../shared/link-auth';
import type { Clock } from './clock';
import { defaultLog, errMessage, type LinkLog } from './common';
import type { Inbox } from './inbox';

export interface IntakeContext {
  /** When the bot received the event (the clock at the start of the request). */
  receivedAt: number;
  /** The clock stamp taken right before the 202 was written. Intake never starts before it. */
  ackedAt: number;
  /** A-115: the signal.new carried a detail the validator dropped as invalid (intake reports bot.contract_violation invalid_detail). */
  detailDropped?: boolean;
}
export interface IntakePort { handle(ev: EngineToBotEvent, ctx: IntakeContext): Promise<void> | void }

export interface EventsServerDeps {
  secret: () => string;
  /** BOT_PORT: the Host header must name this port. 0 = the port the server really listens on (tests). */
  port: number;
  host?: string;
  clock: Clock;
  inbox: Inbox;
  intake: IntakePort;
  log?: LinkLog;
  /**
   * R7-W6 (A-99): the wallet link router (`wallet-link/routes.ts`, the six synchronous /v1/wallet routes). Mounted at /v1/wallet behind the same
   * linkAuth as /v1/events and before the /v1 JSON-404 catch-all, so /v1/nothing and GET /v1/events stay 404 and /v1/events behaves exactly as without
   * it. Absent (WALLET_LINK_ROUTES=0) = nothing under /v1/wallet exists: the paths answer the same JSON 404 as any unknown path.
   */
  wallet?: express.Router;
}

export interface RunningEventsServer { port: number; server: Server; close(): Promise<void> }
export interface EventsServer {
  app: express.Express;
  /** Starts listening on 127.0.0.1 (or deps.host). listenPort defaults to deps.port; 0 picks a free port. */
  listen(listenPort?: number): Promise<RunningEventsServer>;
}

function nack(res: express.Response, status: number, code: Nack['code'], reason: string): void {
  const body: Nack = { ok: false, code, reason };
  res.status(status).json(body);
}

export function createEventsServer(deps: EventsServerDeps): EventsServer {
  const { clock } = deps;
  const log = deps.log ?? defaultLog;
  const app = express();
  app.disable('x-powered-by');

  // the receiver port the Host header is checked against: the configured BOT_PORT, or the real port when the server listens on port 0
  let boundPort = deps.port;
  let built: { port: number; chain: express.RequestHandler[] } | null = null;
  const auth: express.RequestHandler = (req, res, next) => {
    if (built === null || built.port !== boundPort) built = { port: boundPort, chain: linkAuth({ secret: deps.secret, receiverPort: boundPort }) };
    const [check, parse] = built.chain;
    check(req, res, (err?: unknown) => {
      if (err !== undefined) { next(err); return; }
      parse(req, res, next);
    });
  };

  app.use('/v1', auth);

  // R7-W6: the six synchronous wallet routes, behind the auth above and ahead of the catch-all below
  if (deps.wallet !== undefined) app.use('/v1/wallet', deps.wallet);

  app.post('/v1/events', (req, res) => {
    const receivedAt = clock.now();
    const v = validateEngineToBot(req.body, receivedAt);
    if (!v.ok) {
      nack(res, v.status, v.code, v.reason);
      return;
    }
    const ev = v.value;
    const detailDropped = ev.type === 'signal.new' && signalDetailDropped(req.body, ev.payload);
    const duplicate = deps.inbox.checkAndMark(ev.event_id) === 'duplicate';
    // the dedup record is on disk before the Engine is told "accepted"; this is not a side effect of the event
    const ready = duplicate ? Promise.resolve() : deps.inbox.persisted();
    void ready.then(() => {
      const ackedAt = clock.now();
      const ack: Ack = { ok: true, event_id: ev.event_id, duplicate, received_at: receivedAt };
      res.status(202).json(ack);
      if (duplicate) return;
      setImmediate(() => {
        Promise.resolve()
          .then(() => deps.intake.handle(ev, { receivedAt, ackedAt, ...(detailDropped ? { detailDropped: true } : {}) }))
          .catch((e: unknown) => { log(`intake failed for ${ev.type} ${ev.event_id}: ${errMessage(e)}`, 'err'); });
      });
    });
  });

  app.use('/v1', (_req, res) => { nack(res, 404, 'invalid', 'not found'); });
  app.use((_req, res) => { nack(res, 404, 'invalid', 'not found'); });
  // never echo an error message to the caller
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log(`events server error: ${errMessage(err)}`, 'err');
    if (!res.headersSent) nack(res, 500, 'invalid', 'internal error');
  });

  return {
    app,
    listen(listenPort?: number): Promise<RunningEventsServer> {
      const requested = listenPort ?? deps.port;
      return new Promise((resolve, reject) => {
        const server = app.listen(requested, deps.host ?? '127.0.0.1', () => {
          boundPort = (server.address() as AddressInfo).port;
          resolve({
            port: boundPort,
            server,
            close: () => new Promise<void>(done => {
              server.close(() => done());
              server.closeAllConnections?.();
            }),
          });
        });
        server.once('error', reject);
      });
    },
  };
}
