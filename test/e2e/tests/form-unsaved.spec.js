import { test, expect } from "../test-fixtures";
import { syncLV } from "../utils";

let webSocketEvents = [];
let networkEvents = [];

test.beforeEach(async ({ page }) => {
  networkEvents = [];
  webSocketEvents = [];

  page.on("request", (request) =>
    networkEvents.push({ method: request.method(), url: request.url() }),
  );

  page.on("websocket", (ws) => {
    ws.on("framesent", (event) =>
      webSocketEvents.push({ type: "sent", payload: event.payload }),
    );
    ws.on("framereceived", (event) =>
      webSocketEvents.push({ type: "received", payload: event.payload }),
    );
    ws.on("close", () => webSocketEvents.push({ type: "close" }));
  });
});

test("can prevent live navigation and beforeunload", async ({ page }) => {
  await page.goto("/form-unsaved");
  await syncLV(page);

  expect(await page.evaluate(() => window.unsavedEvents)).toEqual([]);

  await page.locator("#unsaved-note").fill("draft");
  await syncLV(page);
  await expect(page.locator("#unsaved-value")).toHaveText(
    "Unsaved value: draft",
  );

  networkEvents = [];
  webSocketEvents = [];

  const confirmPromise = page.waitForEvent("dialog");
  const clickPromise = page.getByRole("link", { name: "Leave form" }).click();
  const confirmDialog = await confirmPromise;
  expect(confirmDialog.type()).toBe("confirm");
  expect(confirmDialog.message()).toBe(
    "You have unsaved changes. Leave without saving?",
  );
  await confirmDialog.dismiss();
  await clickPromise;

  await expect(page).toHaveURL("/form-unsaved");
  expect(networkEvents).toEqual([]);
  expect(webSocketEvents).toEqual([]);
  expect(await page.evaluate(() => window.unsavedEvents)).toEqual([
    {
      type: "phx",
      detail: {
        href: "http://localhost:4004/form-unsaved/target",
        patch: false,
        pop: false,
        direction: "forward",
      },
    },
  ]);

  await page.locator("#unsaved-note").fill("draft after live nav cancel");
  await syncLV(page);
  await expect(page.locator("#unsaved-value")).toHaveText(
    "Unsaved value: draft after live nav cancel",
  );

  const dialogPromise = page.waitForEvent("dialog");
  const closePromise = page.close({ runBeforeUnload: true });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await closePromise;

  expect(page.isClosed()).toBe(false);
  await expect(page).toHaveURL("/form-unsaved");
  await expect(page.locator("#unsaved-note")).toHaveValue(
    "draft after live nav cancel",
  );
  expect(await page.evaluate(() => window.unsavedEvents)).toEqual([
    {
      type: "phx",
      detail: {
        href: "http://localhost:4004/form-unsaved/target",
        patch: false,
        pop: false,
        direction: "forward",
      },
    },
    { type: "beforeunload" },
  ]);
  expect(
    await page.evaluate(() => ({
      connected: window.liveSocket.isConnected(),
      unloaded: window.liveSocket.isUnloaded(),
    })),
  ).toEqual({ connected: true, unloaded: false });

  await page.locator("#unsaved-note").fill("draft after beforeunload cancel");
  await syncLV(page);
  await expect(page.locator("#unsaved-value")).toHaveText(
    "Unsaved value: draft after beforeunload cancel",
  );
});

test("canceling beforeunload from a regular link keeps the LiveView connected", async ({
  page,
}) => {
  await page.goto("/form-unsaved");
  await syncLV(page);

  await page.locator("#unsaved-note").fill("draft");
  await syncLV(page);
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.id = "regular-link";
    link.href = "/form-unsaved/target";
    link.textContent = "Leave with regular link";
    document.body.appendChild(link);
  });

  const dialogPromise = page.waitForEvent("dialog");
  const clickPromise = page.locator("#regular-link").click();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await clickPromise;

  await expect(page).toHaveURL("/form-unsaved");
  expect(
    await page.evaluate(() => ({
      connected: window.liveSocket.isConnected(),
      unloaded: window.liveSocket.isUnloaded(),
    })),
  ).toEqual({ connected: true, unloaded: false });

  await page.locator("#unsaved-note").fill("still interactive");
  await syncLV(page);
  await expect(page.locator("#unsaved-value")).toHaveText(
    "Unsaved value: still interactive",
  );
});

test("attachment responses from regular links and forms keep the LiveView connected", async ({
  page,
}) => {
  await page.goto("/form-unsaved");
  await syncLV(page);

  await page.evaluate(() => {
    window.navigationErrors = [];
    window.addEventListener("phx:page-loading-start", (event) => {
      if (event.detail.kind === "error") {
        window.navigationErrors.push(event.detail);
      }
    });

    const link = document.createElement("a");
    link.id = "attachment-link";
    link.href = "/download";
    link.textContent = "Download from link";
    document.body.appendChild(link);

    const form = document.createElement("form");
    form.id = "attachment-form";
    form.action = "/download";
    form.method = "get";
    const button = document.createElement("button");
    button.textContent = "Download from form";
    form.appendChild(button);
    document.body.appendChild(form);
  });

  let downloadPromise = page.waitForEvent("download");
  await page.locator("#attachment-link").click();
  await downloadPromise;

  await expect(page).toHaveURL("/form-unsaved");
  expect(await page.evaluate(() => window.liveSocket.isUnloaded())).toBe(false);
  expect(await page.evaluate(() => window.navigationErrors)).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => window.liveSocket.isConnected()))
    .toBe(true);

  downloadPromise = page.waitForEvent("download");
  await page.locator("#attachment-form button").click();
  await downloadPromise;

  await expect(page).toHaveURL("/form-unsaved");
  expect(await page.evaluate(() => window.liveSocket.isUnloaded())).toBe(false);
  expect(await page.evaluate(() => window.navigationErrors)).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => window.liveSocket.isConnected()))
    .toBe(true);

  await page.locator("#unsaved-note").fill("still interactive after downloads");
  await syncLV(page);
  await expect(page.locator("#unsaved-value")).toHaveText(
    "Unsaved value: still interactive after downloads",
  );
});

test("canceling beforeunload restores an external phx-change form", async ({
  page,
}) => {
  await page.goto("/form-unsaved");
  await syncLV(page);
  await page.locator("#unsaved-note").fill("draft");
  await syncLV(page);

  await page.evaluate(() => {
    const form = document.querySelector("#unsaved-form");
    form.action = "/form-unsaved/target";
    form.method = "get";
    const button = document.createElement("button");
    button.id = "external-submit";
    button.textContent = "Leave with regular form";
    form.appendChild(button);
  });

  const dialogPromise = page.waitForEvent("dialog");
  const clickPromise = page.locator("#external-submit").click();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await clickPromise;

  await expect(page).toHaveURL("/form-unsaved");
  expect(
    await page.evaluate(() => ({
      connected: window.liveSocket.isConnected(),
      unloaded: window.liveSocket.isUnloaded(),
    })),
  ).toEqual({ connected: true, unloaded: false });
  await expect(page.locator("#external-submit")).toBeEnabled({
    timeout: 7000,
  });
  await expect(page.locator("#unsaved-note")).not.toHaveAttribute("readonly");

  const secondDialogPromise = page.waitForEvent("dialog");
  const secondClickPromise = page.locator("#external-submit").click();
  const secondDialog = await secondDialogPromise;
  expect(secondDialog.type()).toBe("beforeunload");
  await secondDialog.dismiss();
  await secondClickPromise;
  await expect(page.locator("#external-submit")).toBeEnabled({
    timeout: 7000,
  });

  await page.locator("#unsaved-note").fill("still interactive after cancel");
  await syncLV(page);
  await expect(page.locator("#unsaved-value")).toHaveText(
    "Unsaved value: still interactive after cancel",
  );
});
