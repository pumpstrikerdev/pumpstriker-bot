/**
 * R7-W6 (A-99; WALLET-DASHBOARD-DESIGN 6.8): the Express router of the six synchronous wallet link routes.
 *
 *   POST /v1/wallet/quote   POST /v1/wallet/fill   POST /v1/wallet/find
 *   POST /v1/wallet/balances   POST /v1/wallet/close-quote   POST /v1/wallet/close-fill
 *
 * The router carries NO authentication of its own: `createEventsServer` mounts it behind the same `linkAuth` as `/v1/events` (bearer, loopback Host on
 * the bot port, no browser markers, application/json, a 32 KB strict body) and before the `/v1` JSON-404 catch-all, so `req.body` is already the parsed
 * JSON object and every other path or method under /v1 stays a 404. Each route answers synchronously, inside the internal budget of the handler
 * (12 s quote, 60 s fill, 12 s find, 8 s balances, 10 s close-quote, 60 s close-fill), unlike /v1/events, which answers 202 first.
 *
 * Only the frozen contract's path table, the handler and Express types are imported (G-S19: nothing that signs, sends or touches a wallet store).
 */
import express from 'express';
import { WALLET_LINK_PATHS, type WalletLinkRoute } from '../shared/contract/wallet-link';
import type { WalletLinkHandler } from './handler';

export interface WalletRouterDeps {
  handler: WalletLinkHandler;
}

/** The mount point of the router: every route path of the contract starts with it. */
export const WALLET_ROUTER_MOUNT = '/v1/wallet';

/** The path of a route relative to the mount point ('/quote', '/close-quote', ...). */
export function walletRoutePath(route: WalletLinkRoute): string {
  const full: string = WALLET_LINK_PATHS[route];
  if (!full.startsWith(`${WALLET_ROUTER_MOUNT}/`)) throw new Error(`wallet route ${route} is not under ${WALLET_ROUTER_MOUNT}`);
  return full.slice(WALLET_ROUTER_MOUNT.length);
}

export function createWalletRouter(deps: WalletRouterDeps): express.Router {
  const router = express.Router();
  for (const route of Object.keys(WALLET_LINK_PATHS) as WalletLinkRoute[]) {
    router.post(walletRoutePath(route), (req, res) => {
      void deps.handler.handle(route, req.body).then(
        result => {
          // a quote carries the bytes of a transaction and a fill carries the owner's amounts: nothing here is cacheable
          res.set('Cache-Control', 'no-store');
          res.status(result.status).json(result.body);
        },
        () => {
          // handle() does not reject; if it ever did, the caller still gets a well-formed refusal and never an error text
          if (!res.headersSent) res.status(500).json({ ok: false, code: 'build-failed', reason: 'internal error' });
        },
      );
    });
  }
  return router;
}
