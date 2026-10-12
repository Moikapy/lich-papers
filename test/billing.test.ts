import { describe, expect, it } from "vitest";
import { periodEnd, stripeForm, verifyStripeSignature } from "../src/worker/billing";
import { billedTo, PRO_FREE_PROVIDER, PRO_PROVIDER, SHARED_PROVIDER } from "../src/worker/providers";

async function sign(body: string, secret: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifyStripeSignature", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1","type":"customer.subscription.updated"}';
  const now = 1_800_000_000;

  it("accepts a valid signature, including alongside other v1 entries", async () => {
    const sig = await sign(body, secret, now);
    expect(await verifyStripeSignature(body, `t=${now},v1=${sig}`, secret, now)).toBe(true);
    expect(await verifyStripeSignature(body, `t=${now},v1=deadbeef,v1=${sig},v0=old`, secret, now + 10)).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets, stale timestamps, and junk headers", async () => {
    const sig = await sign(body, secret, now);
    expect(await verifyStripeSignature(body + " ", `t=${now},v1=${sig}`, secret, now)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${now},v1=${sig}`, "whsec_other", now)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${now},v1=${sig}`, secret, now + 301)).toBe(false);
    expect(await verifyStripeSignature(body, undefined, secret, now)).toBe(false);
    expect(await verifyStripeSignature(body, "garbage", secret, now)).toBe(false);
    expect(await verifyStripeSignature(body, `t=abc,v1=${sig}`, secret, now)).toBe(false);
  });
});

describe("stripeForm", () => {
  it("encodes nested objects and arrays the way Stripe expects", () => {
    const form = stripeForm({
      mode: "subscription",
      line_items: [{ quantity: 1, price_data: { unit_amount: 1000, recurring: { interval: "month" } } }],
      metadata: { user_id: "u 1" },
      skip: undefined,
    });
    expect(decodeURIComponent(form)).toBe(
      "mode=subscription&line_items[0][quantity]=1&line_items[0][price_data][unit_amount]=1000&line_items[0][price_data][recurring][interval]=month&metadata[user_id]=u 1",
    );
  });
});

describe("periodEnd", () => {
  it("reads the period end from the subscription or, on newer API versions, its first item", () => {
    expect(periodEnd({ id: "s", status: "active", customer: "c", current_period_end: 100 })).toBe(100_000);
    expect(periodEnd({ id: "s", status: "active", customer: "c", items: { data: [{ current_period_end: 200 }] } })).toBe(200_000);
    expect(periodEnd({ id: "s", status: "active", customer: "c" })).toBeNull();
  });
});

describe("billedTo", () => {
  it("attributes replies to the party that pays for them", () => {
    expect(billedTo(PRO_PROVIDER)).toBe("pro");
    expect(billedTo(PRO_FREE_PROVIDER)).toBe("pro");
    expect(billedTo(SHARED_PROVIDER)).toBe("trial");
    expect(billedTo("openai")).toBe("user");
    expect(billedTo(null)).toBe("user");
  });
});
