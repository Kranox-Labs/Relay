// Starts the relay of the bridge: pnpm start on a machine whose Node strips types. The server runs dist/main.mjs,
// which pnpm build compiles from these sources.
import { Alchemy } from "./alchemy.mts";
import { Blockscout } from "./blockscout.mts";
import { ChangeNow } from "./changenow.mts";
import { CREATION_KEY_ENTRIES, CREATION_KEY_MS, loadConfig } from "./config.mts";
import { CreationKeys } from "./creations.mts";
import { OneClick } from "./oneclick.mts";
import { FallbackScanner } from "./scan.mts";
import { createRelay } from "./server.mts";
import { AnswerSigner } from "./signing.mts";
import { SimpleSwap } from "./simpleswap.mts";
import { SwapTokens } from "./tokens.mts";

const config = loadConfig();
// The scan reads Alchemy first and Blockscout when Alchemy fails, such as when its budget is spent; with one key it
// reads that source alone, and without a key it cannot scan. Alchemy reads no internal transfer here, so Blockscout
// also reads the first funding of each scan of Alchemy.
const blockscout = config.blockscoutApiKey === null ? null : new Blockscout(config.blockscoutApiKey);
const alchemy =
  config.alchemyApiKey === null ? null : new Alchemy(config.alchemyApiKey, { funding: blockscout ?? undefined });
const sources = [...(alchemy === null ? [] : [alchemy]), ...(blockscout === null ? [] : [blockscout])];
const scanner = sources.length === 0 ? null : sources.length === 1 ? sources[0] : new FallbackScanner(sources);
const relay = createRelay({
  exchanger: new ChangeNow(config.changenowApiKey),
  simpleswap: config.simpleswapApiKey === null ? null : new SimpleSwap(config.simpleswapApiKey),
  // 1Click serves the relay with or without a partner key, so the exchanger of Starknet is always there.
  oneclick: new OneClick(config.oneclickApiKey),
  scanner,
  tokens: new SwapTokens(config.swapTokenKey),
  creations: new CreationKeys(CREATION_KEY_MS, CREATION_KEY_ENTRIES),
  signer: new AnswerSigner(config.answerSigningKey),
  allowedOrigins: config.allowedOrigins,
});
relay.listen(config.port, config.host, () => {
  // The only line that the relay writes: where it answers. It never writes a request.
  console.log(`The relay of the bridge answers at http://${config.host}:${config.port}`);
});
