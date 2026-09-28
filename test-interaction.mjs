// Focused interaction test for Moonshot using the SDK's automated harness
// (mock wallet + sample Friend #7730). Exercises boarding, a full flight with
// fuel cans and cash-out (or crash), the runtime pause lifecycle, Burn for
// Glory, a hangar burn, the Flames tab and auto-launch, and fails on any
// browser/runtime error.
//   node test-interaction.mjs [width]
import { testGame } from "@rarefriends/friendsdk/testing";

const width = Number(process.argv[2] || 960);

await testGame("./games/moonshot", {
  width,
  screenshot: `./artifacts/moonshot-${width}.png`,
  check: async ({ page, game }) => {
    const go = game.locator(".ms-go");
    const balance = game.locator(".ms-bal strong");
    await go.waitFor({ timeout: 30000 });

    // Join a launch during boarding (book the next one if a flight is on).
    await game.getByText("LAUNCH IN", { exact: true }).waitFor({ timeout: 20000 });
    await game.getByRole("button", { name: /JOIN THIS LAUNCH/ }).click();
    await game.getByRole("button", { name: /YOU'RE BOARDING/ }).waitFor({ timeout: 3000 });
    if ((await balance.innerText()) !== "990") throw new Error(`stake not reserved: ${await balance.innerText()}`);

    // Liftoff: CASH OUT appears (a 1.00x instant bust is a valid outcome).
    const cash = game.getByRole("button", { name: /CASH OUT/ });
    const crashed = game.getByText(/CRASHED @/);
    await Promise.race([cash.waitFor({ timeout: 15000 }), crashed.waitFor({ timeout: 15000 })]);

    if (await cash.isVisible()) {
      // Fuel cans: each throw burns exactly 1 RF from the balance.
      const can = game.getByRole("button", { name: /Throw a fuel can/ }).first();
      if (await can.isVisible()) {
        const b0 = Number((await balance.innerText()).replace(/,/g, ""));
        await can.click();
        const b1 = Number((await balance.innerText()).replace(/,/g, ""));
        if (Math.abs(b0 - 1 - b1) > 0.001) throw new Error(`fuel can burn mismatch ${b0} -> ${b1}`);
      }
      // Pause lifecycle: opening a runtime menu mid-flight freezes the round.
      await page.getByRole("button", { name: "Open Friend wallet" }).click();
      await game.locator('section[aria-label="Moonshot"][aria-busy="true"]').waitFor({ timeout: 5000 });
      const mult = game.locator(".ms-mult");
      const a = await mult.innerText();
      await page.waitForTimeout(1200);
      const b = await mult.innerText();
      if (a !== b) throw new Error(`round did not freeze while paused: ${a} -> ${b}`);
      await page.keyboard.press("Escape");
      await game.locator('section[aria-label="Moonshot"][aria-busy="false"]').waitFor({ timeout: 5000 });
      try {
        await cash.click({ timeout: 3000 });
        await game.getByText(/Ejected at/).waitFor({ timeout: 3000 });
      } catch {
        await crashed.waitFor({ timeout: 20000 });
      }
    }
    await crashed.waitFor({ timeout: 60000 });
    await game.locator(".ms-hp").first().waitFor();

    // Hangar: buying a skin burns 100% after a confirm click.
    await game.getByRole("tab", { name: "Hangar" }).click();
    const before = Number((await balance.innerText()).replace(/,/g, ""));
    const tin = game.getByRole("button", { name: /Tin Toy/ });
    await tin.click();
    await game.getByText("burn 25 RF?").waitFor();
    await tin.click();
    await game.getByText(/Burned 25 RF/).waitFor({ timeout: 3000 });
    const after = Number((await balance.innerText()).replace(/,/g, ""));
    if (Math.abs(before - 25 - after) > 0.001) throw new Error(`hangar burn mismatch ${before} -> ${after}`);

    // Flames tab shows the burn breakdown, rank and Hall of Flames.
    await game.getByRole("tab", { name: "Flames" }).click();
    await game.getByText("You burned", { exact: true }).waitFor();
    await game.getByText("Hall of Flames").waitFor();

    // Burn for Glory + auto eject + auto-launch: the next launch books itself.
    await game.getByRole("checkbox", { name: "Burn for glory" }).check();
    await game.getByRole("checkbox", { name: "Auto-launch" }).check();
    await game.getByText(/SUPERNOVA LAUNCH|LAUNCH IN/).first().waitFor({ timeout: 20000 });
    await game.getByRole("button", { name: /YOU'RE BOARDING|CASH OUT/ }).waitFor({ timeout: 8000 });
    await game.getByRole("checkbox", { name: "Auto-launch" }).uncheck();

    // Sound toggle.
    await game.getByRole("button", { name: "Sound on" }).click();
    await game.getByRole("button", { name: "Sound off" }).waitFor();
  },
});

console.log(`INTERACTION PASS at ${width}px: boarding, fuel cans, flight, pause, hangar burn, Flames tab, glory and auto-launch with no errors`);
