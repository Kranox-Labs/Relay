// Starts the relay of the bridge: pnpm start on a machine whose Node strips types. The server runs dist/main.mjs,
// which pnpm build compiles from these sources.
import { Alchemy } from "./alchemy.mts";
import { Blockscout } from "./blockscout.mts";
import { ChangeNow } from "./changenow.mts";
import { loadConfig } from "./config.mts";
import { createRelay } from "./server.mts";

const config = loadConfig();
// The scan reads Alchemy when the relay has its key, Blockscout otherwise, and nothing without either.
const scanner =
  config.alchemyApiKey !== null
    ? new Alchemy(config.alchemyApiKey)
    : config.blockscoutApiKey !== null
      ? new Blockscout(config.blockscoutApiKey)
      : null;
const relay = createRelay(new ChangeNow(config.changenowApiKey), scanner);
relay.listen(config.port, config.host, () => {
  // The only line that the relay writes: where it answers. It never writes a request.
  console.log(`The relay of the bridge answers at http://${config.host}:${config.port}`);
});
