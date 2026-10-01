/**
 * Text from a map file reaches the page as text, never as markup.
 *
 * A KML is someone else's file. Its descriptions are HTML by convention and
 * its names can hold anything, so a hostile one can carry
 * `<img src=x onerror=...>`. Markup given to an element of the page's own
 * document loads that image and runs the handler -- whether or not the element
 * is attached -- and the page runs on a site that has other things worth
 * reaching. Whether a script ran is something only a browser can show: Node
 * has no DOM, and test/dom-shim.mjs never runs one. So this drives Chrome,
 * headless, over the committed single file, the copy people actually open.
 *
 * A control runs first in the same page: markup put into a detached element
 * of the page's own document MUST run its handler. Without that, "no handler
 * ran" could equally mean the harness cannot see one run.
 *
 * Skipped when no Chrome is found, except in CI, where a skip would quietly
 * remove the only check of this. CHROME=/path/to/chrome picks one by hand.
 *
 *     node --test web/test/browser.test.mjs
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const built = join(dirname(here), "kmz-extractor.html");

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

const chrome = findChrome();
if (!chrome && process.env.CI) {
  throw new Error("no Chrome found in CI: the markup check below would silently not run");
}

// Every point has unusable coordinates, so each one becomes a warning naming
// it and no workbook is written -- a headless download is not this test.
const HOSTILE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>&lt;b&gt;bold&lt;/b&gt;</name>
<description><![CDATA[<p>Survey</p><img src="missing-description.png" onerror="__flag('description')">]]></description>
<Point><coordinates>not numbers</coordinates></Point></Placemark>
<Placemark><name>&lt;img src="missing-name.png" onerror="__flag('warning')"&gt;</name>
<Point><coordinates>nonsense</coordinates></Point></Placemark>
</Document></kml>`;

// Runs after the page's own script. That one is a classic script in the
// built file, so its top-level `input`, `convertButton`, `result` and
// `selected` are reachable from here by name.
const PROBE = `<script>
(async () => {
  const report = { ran: [] };
  window.__flag = (name) => report.ran.push(name);
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Each case gets its own control, started the moment its result is on
  // the page, so a handler that would have run in that window is seen to.
  const shown = async (label) => {
    for (let tries = 0; tries < 100 && result.hidden; tries += 1) await settle(50);
    document.createElement("div").innerHTML =
      '<img src="missing-' + label + '.png" onerror="__flag(\\'' + label + ' control\\')">';
    await settle(500); // time for a missing image's error event
    return {
      shown: !result.hidden,
      text: result.textContent,
      elements: [...result.querySelectorAll("*")].map((element) => element.localName),
    };
  };

  document.createElement("div").innerHTML =
    '<img src="missing-control.png" onerror="__flag(\\'control\\')">';

  // Parsed as a whole document, a leading <title> lands in <head>, not
  // <body>. kmz_points/kml_parser.py reads every text node of the fragment,
  // so this is "Tx" there and must be here. The shim has no <head> to put it
  // in, so only a browser can tell.
  report.titleText = __modules["kml.js"].plainText("<title>T</title>x");

  const files = new DataTransfer();
  files.items.add(new File([${JSON.stringify(HOSTILE_KML).replace(/</g, "\\u003c")}], "hostile.kml"));
  input.files = files.files;
  input.dispatchEvent(new Event("change"));
  convertButton.click();
  report.conversion = await shown("conversion");

  // The page's last-resort message. Its text is whatever the error says,
  // which is not the page's to vouch for.
  result.hidden = true;
  selected = [{
    name: "broken.kml",
    arrayBuffer: () =>
      Promise.reject(new Error('<img src="missing-error.png" onerror="__flag(\\'error\\')"><b>boom</b>')),
  }];
  convertButton.disabled = false;
  convertButton.click();
  report.failure = await shown("failure");

  const out = document.createElement("pre");
  out.id = "report";
  out.textContent = encodeURIComponent(JSON.stringify(report));
  document.body.append(out);
})();
</script>`;

/**
 * Print the page once its probe has run, and return the probe's report.
 *
 * Chrome prints the DOM and then, on macOS at least, does not exit, so it is
 * stopped here -- its whole process group, helpers included -- as soon as the
 * printed page is complete, and by a deadline if it never is.
 */
async function runInChrome() {
  const scratch = mkdtempSync(join(tmpdir(), "kmz-browser-"));
  let browser;
  let abandon;
  try {
    const html = readFileSync(built, "utf8");
    const at = html.lastIndexOf("</body>");
    assert.ok(at !== -1, "the built page has no </body> to put the probe before");
    const harness = join(scratch, "harness.html");
    writeFileSync(harness, html.slice(0, at) + PROBE + html.slice(at));

    browser = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(scratch, "profile")}`,
        "--virtual-time-budget=20000",
        "--dump-dom",
        pathToFileURL(harness).href,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    // Stopped halfway (Ctrl-C, a cancelled run), `finally` never runs and a
    // detached Chrome would outlive the test, with its folder.
    abandon = () => {
      try {
        process.kill(-browser.pid, "SIGKILL");
      } catch {}
      rmSync(scratch, { recursive: true, force: true });
      process.exit(130);
    };
    process.once("SIGINT", abandon);
    process.once("SIGTERM", abandon);
    const dom = await new Promise((resolve, reject) => {
      let printed = "";
      const deadline = setTimeout(() => reject(new Error("Chrome printed no page within 60 s")), 60_000);
      browser.on("error", reject);
      browser.stdout.setEncoding("utf8");
      browser.stdout.on("data", (chunk) => {
        printed += chunk;
        if (printed.includes("</html>")) {
          clearTimeout(deadline);
          resolve(printed);
        }
      });
      browser.on("exit", () => {
        clearTimeout(deadline);
        resolve(printed);
      });
    });

    const found = dom.match(/<pre id="report">([^<]*)<\/pre>/);
    assert.ok(found, "the probe never finished: Chrome printed the page without its report");
    return JSON.parse(decodeURIComponent(found[1]));
  } finally {
    if (abandon) {
      process.off("SIGINT", abandon);
      process.off("SIGTERM", abandon);
    }
    await stop(browser);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Stop Chrome and every helper it started, then wait for it to go. */
async function stop(browser) {
  if (!browser || browser.exitCode !== null || browser.signalCode !== null) return;
  const gone = new Promise((resolve) => browser.once("exit", resolve));
  try {
    process.kill(-browser.pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  const late = setTimeout(() => {
    try {
      process.kill(-browser.pid, "SIGKILL");
    } catch {}
  }, 5_000);
  await gone;
  clearTimeout(late);
}

test("file text cannot run script in the page or become its markup", { skip: !chrome && "no Chrome found" }, async (t) => {
  const report = await runInChrome();
  t.diagnostic(`what the page did: ${JSON.stringify(report)}`);

  assert.ok(
    report.ran.includes("control"),
    "the control did not run, so this harness cannot see a handler run at all",
  );

  assert.equal(report.titleText, "Tx", "a description's leading <title> text was dropped");

  const { conversion, failure } = report;
  assert.ok(conversion.shown, "the conversion never showed a result");
  assert.ok(failure.shown, "the failure path never showed a result");

  for (const label of ["conversion", "failure"]) {
    assert.ok(
      report.ran.includes(`${label} control`),
      `the ${label} control did not run in its window, so a planted handler might not have either`,
    );
  }

  assert.ok(!report.ran.includes("description"), "a description's onerror ran in the page");
  assert.ok(!report.ran.includes("warning"), "a placemark name's onerror ran in a warning");
  assert.ok(!report.ran.includes("error"), "an error message's onerror ran");
  assert.deepEqual(
    [...report.ran].sort(),
    ["control", "conversion control", "failure control"],
    "something other than the controls ran",
  );

  assert.ok(
    conversion.text.includes("skipped <b>bold</b> (bad coordinates)"),
    `the <b> in a placemark's name is not shown as text: ${JSON.stringify(conversion.text)}`,
  );
  assert.ok(
    conversion.text.includes('skipped <img src="missing-name.png"'),
    "the <img> in a placemark's name is not shown as text",
  );
  assert.ok(failure.text.includes("<b>boom</b>"), "the error's <b> is not shown as text");

  // Only the page's own wrappers: a summary box, and a paragraph per message.
  for (const [name, part] of [["conversion", conversion], ["failure", failure]]) {
    const foreign = part.elements.filter((element) => element !== "div" && element !== "p");
    assert.deepEqual(foreign, [], `the ${name} result holds elements from the file: ${foreign}`);
  }
});
