/**
 * React context carrying the (single) GatewayClient instance into chrome
 * surfaces. `undefined` is a legal value — chrome renders NO SIGNAL states
 * without a client (e.g. component tests, storybook-style harnesses).
 */

import { createContext, useContext } from 'react';
import type { GatewayClient } from '../lib/ws/wsClient.ts';

const ClientContext = createContext<GatewayClient | undefined>(undefined);

export const ClientProvider = ClientContext.Provider;

export function useGatewayClient(): GatewayClient | undefined {
  return useContext(ClientContext);
}
