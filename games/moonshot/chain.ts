/**
 * Read-only chain facts for the burn display. The only call is the RF token's
 * totalSupply() on Robinhood mainnet (the RPC the SDK sandbox allows), so the
 * Flames tab can express the session burn as a share of the real supply.
 * Never rejects: returns null when the read is unavailable.
 */
export const RF_TOKEN = "0x0779369854d3EcdEA927206718FFD7730C67B71f"; // FriendSDK fishing deployment "rf"
const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

export async function readRfSupply(timeoutMs = 6000): Promise<bigint | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: RF_TOKEN, data: "0x18160ddd" }, "latest"] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string };
    if (typeof json.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(json.result)) return null;
    const v = BigInt(json.result);
    return v > 0n ? v : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
