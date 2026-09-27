// Focused interaction test for Moonshot using the SDK's automated harness
// (mock wallet + sample Friends). Exercises a full round: launch -> cash out
// (or crash) -> fly again, and fails on any browser/runtime error.
import { testGame } from "@rarefriends/friendsdk/testing";

await testGame("./games/moonshot", {
  width: 480,
  screenshot: "./artifacts/moonshot.png",
  check: async ({ page, game }) => {
    // Wait for the session to load and the LAUNCH button to appear.
    const launch = game.getByRole("button", { name: /LAUNCH/ });
    await launch.waitFor({ timeout: 30000 });

    // Pick a 25 RF stake via the preset chip.
    await game.getByRole("button", { name: "25", exact: true }).click();
    await launch.click();

    // Countdown (3s) then flying: CASH OUT appears.
    const cashout = game.getByRole("button", { name: "CASH OUT", exact: true });
    await cashout.waitFor({ timeout: 20000 });

    // Pause lifecycle: opening a runtime menu mid-flight must freeze the
    // round (multiplier stops) without forfeiting the stake.
    const mult = game.locator(".ms-mult");
    await page.getByRole("button", { name: "Open Friend wallet" }).click();
    await game.locator('section[aria-label="Moonshot"][aria-busy="true"]').waitFor({ timeout: 5000 });
    const frozen1 = await mult.innerText();
    await page.waitForTimeout(1500);
    const frozen2 = await mult.innerText();
    if (frozen1 !== frozen2) throw new Error(`Round did not freeze while paused: ${frozen1} -> ${frozen2}`);
    await page.keyboard.press("Escape");
    await game.locator('section[aria-label="Moonshot"][aria-busy="false"]').waitFor({ timeout: 5000 });

    // The round may crash first (instant 3% bust or a fast low crash) —
    // both are valid outcomes.
    try {
      await cashout.click({ timeout: 20000 });
      await game.getByText(/Cashed out/).waitFor({ timeout: 8000 });
    } catch {
      await game.getByText(/Crashed at/).waitFor({ timeout: 8000 });
    }

    // Round history recorded the flight.
    await game.getByText(/Recent flights/).waitFor();

    // Fly again returns to the idle controls.
    await game.getByRole("button", { name: "FLY AGAIN", exact: true }).click();
    await game.getByRole("button", { name: /LAUNCH/ }).waitFor({ timeout: 8000 });

    // Toggles work.
    await game.getByRole("button", { name: /🔇|🔊/ }).first().click();
  },
});

console.log("INTERACTION PASS: full round completed with no errors");
