// Starts the relay of the bridge: pnpm start on a machine whose Node strips types. The server runs dist/main.mjs,
// which pnpm build compiles from these sources.
import { Alchemy } from "./alchemy.mts";
import { Blockscout } from "./blockscout.mts";
import { ChangeNow } from "./changenow.mts";
import { CREATION_KEY_ENTRIES, CREATION_KEY_MS, loadConfig } from "./config.mts";
import { CreationKeys } from "./creations.mts";
import { FallbackScanner } from "./scan.mts";
import { createRelay } from "./server.mts";
import { SwapTokens } from "./tokens.mts";

const config = loadConfig();
// The scan reads Alchemy first and Blockscout when Alchemy fails, such as when its budget is spent; with one key it
// reads that source alone, and without a key it cannot scan.
const sources = [
  ...(config.alchemyApiKey === null ? [] : [new Alchemy(config.alchemyApiKey)]),
  ...(config.blockscoutApiKey === null ? [] : [new Blockscout(config.blockscoutApiKey)]),
];
const scanner = sources.length === 0 ? null : sources.length === 1 ? sources[0] : new FallbackScanner(sources);
const relay = createRelay({
  exchanger: new ChangeNow(config.changenowApiKey),
  scanner,
  tokens: new SwapTokens(config.swapTokenKey),
  creations: new CreationKeys(CREATION_KEY_MS, CREATION_KEY_ENTRIES),
});
relay.listen(config.port, config.host, () => {
  // The only line that the relay writes: where it answers. It never writes a request.
  console.log(`The relay of the bridge answers at http://${config.host}:${config.port}`);
});
