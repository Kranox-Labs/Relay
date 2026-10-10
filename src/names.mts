// The public names of addresses on Robinhood Chain from the metadata service of Blockscout, which needs no key: the
// scan of Alchemy names its parties with it, and the first funding of a scan names its sender with it.
import { METADATA_URL, ROBINHOOD_CHAIN_ID, UPSTREAM_TIMEOUT_MS } from "./config.mts";
import { objectOrNull, stringOrNull } from "./json.mts";
import { EVM_ADDRESS_PATTERN } from "./scan.mts";

/** The tag of type "name" of each of [addresses] that has one, by the lowercase address. */
export async function readNames(fetchImpl: typeof fetch, addresses: string[]): Promise<Map<string, string>> {
  const query = new URLSearchParams({
    addresses: addresses.filter((address) => EVM_ADDRESS_PATTERN.test(address)).join(","),
    chainId: String(ROBINHOOD_CHAIN_ID),
  });
  const url = `${METADATA_URL}?${query}`;
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!response.ok) throw new Error("The metadata service failed.");
  const known = objectOrNull(objectOrNull(await response.json())?.addresses) ?? {};
  const names = new Map<string, string>();
  for (const [address, value] of Object.entries(known)) {
    const tags = objectOrNull(value)?.tags;
    const tag = (Array.isArray(tags) ? tags : [])
      .map((item) => objectOrNull(item))
      .find((item) => item?.tagType === "name" && stringOrNull(item.name) !== null);
    const name = stringOrNull(tag?.name);
    if (name !== null) names.set(address.toLowerCase(), name);
  }
  return names;
}
