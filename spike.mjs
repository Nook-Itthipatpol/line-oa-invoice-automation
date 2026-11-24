// One-account test of Playwright against LINE OA Manager.
//
//   node spike.mjs login            Opens Chrome. You log in by hand. Saves the session.
//   node spike.mjs check            Is the saved session still logged in?
//   node spike.mjs inspect [@id]    Saves what the pages look like, to calibrate the script.
//   node spike.mjs run @id 2026-10  Downloads and verifies that account's invoices for the month.
//
// The only thing this script ever clicks is an invoice's "Issued" download link. It never types.
// Exit codes: 0 ok, 1 error or unresolved work, 2 not logged in or security check.

import { chromium } from 'playwright';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(ROOT, '.browser-profile');
const OUTPUT = join(ROOT, 'output', 'inspect');
const MANAGER = 'https://manager.line.biz/';
const MANAGER_HOST = 'manager.line.biz';
const WAIT_MS = 15_000;
const LOGIN_WAIT_MS = 10 * 60_000;

class NotLoggedIn extends Error {}

async function openBrowser({ headless }) {
  await mkdir(PROFILE, { recursive: true, mode: 0o700 });
  // Real Chrome with its own separate profile, not your everyday Chrome profile.
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  });
  // Safety net: nothing related to refunds may ever be requested.
  await context.route(/refund/i, (route) => route.abort());
  return context;
}

const stripQuery = (url) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname + (u.search ? '?…' : '');
  } catch {
    return url;
  }
};

async function login() {
  const context = await openBrowser({ headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  let closed = false;
  context.on('close', () => { closed = true; });

  await page.goto(MANAGER, { waitUntil: 'domcontentloaded' });
  console.log('Log in using the Chrome window. Waiting up to 10 minutes...');

  const deadline = Date.now() + LOGIN_WAIT_MS;
  let stableSince = null;
  while (Date.now() < deadline && !closed) {
    const onManager = new URL(page.url()).hostname === MANAGER_HOST;
    stableSince = onManager ? stableSince ?? Date.now() : null;
    if (stableSince && Date.now() - stableSince > 5_000) {
      await context.close();
      console.log('Login detected and session saved.');
      return 0;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  if (!closed) await context.close();
  console.log(closed ? 'Chrome was closed before login finished.' : 'Timed out waiting for login.');
  return 2;
}

async function goto(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: WAIT_MS }).catch(() => {});
  const host = new URL(page.url()).hostname;
  if (host !== MANAGER_HOST) {
    throw new NotLoggedIn(`Sent to ${host} instead of ${MANAGER_HOST}`);
  }
}

async function check() {
  const context = await openBrowser({ headless: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await goto(page, MANAGER);
    console.log(`Logged in. Landed on ${stripQuery(page.url())}`);
    return 0;
  } finally {
    await context.close();
  }
}

// Reads the page's structure without touching anything on it.
async function snapshot(page, name, requests) {
  const data = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const links = [...document.querySelectorAll('a[href]')].map((a) => ({
      text: clean(a.innerText).slice(0, 80),
      href: a.href,
    }));
    const controls = [...document.querySelectorAll('button, [role=button], [aria-label]')]
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: clean(el.innerText).slice(0, 60),
        aria: el.getAttribute('aria-label'),
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
        cls: clean(el.className?.toString()).slice(0, 60),
      }))
      .slice(0, 100);
    const headings = [...document.querySelectorAll('h1,h2,h3,h4')].map((h) => clean(h.innerText));
    const tables = [...document.querySelectorAll('table')].map((t) => ({
      headers: [...t.querySelectorAll('th')].map((th) => clean(th.innerText)),
      rows: t.querySelectorAll('tbody tr').length,
    }));
    const invoiceLink = document.querySelector('a[href*="/purchase/history/invoice/"]');
    const parentChain = [];
    for (let el = invoiceLink; el && parentChain.length < 8; el = el.parentElement) {
      parentChain.push(el.tagName.toLowerCase() + (el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''));
    }
    return {
      title: document.title,
      lang: document.documentElement.lang,
      headings,
      tables,
      links,
      controls,
      invoiceLinkParents: parentChain,
      text: document.body.innerText,
    };
  });

  const fullLinks = data.links;
  data.url = stripQuery(page.url());
  data.links = fullLinks.map((l) => ({ ...l, href: stripQuery(l.href) }));
  data.backgroundRequests = [...requests];
  requests.clear();

  await mkdir(OUTPUT, { recursive: true });
  await writeFile(join(OUTPUT, `${name}.json`), JSON.stringify(data, null, 2));
  await page.screenshot({ path: join(OUTPUT, `${name}.png`), fullPage: true });
  console.log(`Saved ${name}: "${data.headings[0] ?? data.title}", ${data.links.length} links, ${data.tables.length} tables`);
  return fullLinks;
}

async function inspect(accountId) {
  if (accountId && !/^@[\w.-]+$/.test(accountId)) {
    console.log('Account ID must look like @abc1234');
    return 1;
  }
  const context = await openBrowser({ headless: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const requests = new Set();
    page.on('request', (r) => {
      if (['xhr', 'fetch'].includes(r.resourceType())) requests.add(`${r.method()} ${stripQuery(r.url())}`);
    });

    await goto(page, MANAGER);
    await snapshot(page, 'accounts', requests);
    if (!accountId) return 0;

    const history = `${MANAGER}account/${accountId}/purchase/history`;
    await goto(page, history);
    const links = await snapshot(page, 'billing', requests);

    const invoice = links.find((l) => l.href.includes('/purchase/history/invoice/'));
    if (!invoice) {
      console.log('No invoice links on this page (could be empty, or could be a page problem). Check billing.png.');
      return 0;
    }
    await goto(page, invoice.href);
    await snapshot(page, 'invoice', requests);
    return 0;
  } finally {
    await context.close();
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// The site shows MM/DD/YYYY. The PDF check below independently confirms the month.
function parseSiteDate(text) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  return m ? { month: Number(m[1]), day: Number(m[2]), year: Number(m[3]) } : null;
}

const money = (text) => /฿?\s*([\d,]+\.\d{2})/.exec(text)?.[1].replace(/,/g, '') ?? null;
const safeName = (s) => s.replace(/[/\\:*?"<>|]/g, '-');

function nextFreeFolder(base) {
  if (!existsSync(base)) return base;
  for (let i = 2; ; i++) if (!existsSync(`${base} (${i})`)) return `${base} (${i})`;
}

async function saveState(folder, state) {
  const tmp = join(folder, 'state.json.tmp');
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, join(folder, 'state.json'));
}

async function pdfText(path) {
  const task = getDocument({ data: new Uint8Array(await readFile(path)), verbosity: 0 });
  const pdf = await task.promise;
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    parts.push(content.items.map((item) => item.str.trim()).filter(Boolean).join('\n'));
  }
  await task.destroy();
  return parts.join('\n');
}

async function readBilling(page, accountId, accountName) {
  await goto(page, `${MANAGER}account/${accountId}/purchase/history`);
  const empty = page.getByText(/Nothing here yet/i);
  try {
    await page.locator('table tbody tr').or(empty).first().waitFor({ timeout: WAIT_MS });
  } catch {
    throw new Error('Billing page did not show a table or an empty message. This does NOT mean no invoices.');
  }
  if (!page.url().includes(`/account/${accountId}/purchase/history`)) throw new Error(`Wrong page: ${page.url()}`);
  if (!(await page.getByRole('heading', { name: 'Billing history' }).isVisible())) throw new Error('Billing history heading missing');
  if (!(await page.getByText(accountName, { exact: true }).first().isVisible())) throw new Error(`Account name "${accountName}" not on page`);

  if (await empty.first().isVisible()) return { rows: [], pages: 1 };

  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const headers = [...document.querySelectorAll('table th')].map((th) => clean(th.innerText));
    const rows = [...document.querySelectorAll('table tbody tr')].map((tr) => {
      const cells = [...tr.children].map((td) => clean(td.innerText));
      const row = Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
      row.detailsUrl = tr.querySelector('a[href*="/purchase/history/invoice/"]')?.href ?? null;
      return row;
    });
    const pages = [...document.querySelectorAll('nav[aria-label="Page navigation"] .page-link')]
      .filter((a) => /^\d+$/.test(clean(a.innerText))).length;
    return { rows, pages };
  });
}

async function readInvoicePage(page, row, accountId, txId) {
  await goto(page, row.detailsUrl);
  try {
    await page.waitForFunction(() => /Invoice status\s+Status\s+\S/.test(document.body.innerText), null, { timeout: WAIT_MS });
  } catch {
    throw new Error('Invoice status did not appear');
  }
  if (!page.url().includes(`/account/${accountId}/purchase/history/invoice/${txId}`)) throw new Error(`Wrong page: ${page.url()}`);
  if (!(await page.getByRole('heading', { name: 'Tax invoice details' }).isVisible())) throw new Error('Tax invoice details heading missing');
  const body = await page.evaluate(() => document.body.innerText);
  return {
    status: /Invoice status\s+Status\s+(.+)/.exec(body)[1].trim(),
    paymentDate: /Payment date\s+(.+)/.exec(body)?.[1].trim() ?? null,
    item: /Item purchased\s+(.+)/.exec(body)?.[1].trim() ?? null,
    amount: money(/Amount\s+(.+)/.exec(body)?.[1] ?? ''),
  };
}

async function downloadIssued(context, page, txId, path) {
  const link = page.locator(`a[href*="/receipt/${txId}/download"]`).filter({ hasText: /^\s*Issued\s*$/ });
  if ((await link.count()) !== 1) throw new Error('Could not find exactly one Issued link for this transaction');

  for (let attempt = 1; attempt <= 2; attempt++) {
    const got = new Promise((resolve) => {
      page.once('download', resolve);
      context.once('page', (popup) => popup.once('download', resolve));
    });
    await link.click();
    const download = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), WAIT_MS))]);
    if (download && !(await download.failure())) {
      await download.saveAs(path);
      return { attempt, suggestedFilename: download.suggestedFilename() };
    }
  }
  throw new Error('Download did not start after 2 attempts');
}

async function run(accountId, month) {
  const scope = /^(\d{4})-(\d{2})$/.exec(month ?? '');
  if (!/^@[\w.-]+$/.test(accountId ?? '') || !scope) {
    console.log('Use: node spike.mjs run @account-id 2026-10');
    return 1;
  }
  const year = Number(scope[1]);
  const monthNumber = Number(scope[2]);
  const monthName = MONTHS[monthNumber - 1];

  const folder = nextFreeFolder(join(ROOT, 'output', `LINE OA invoice ${year} ${monthName}`));
  await mkdir(join(folder, 'downloads'), { recursive: true });
  const state = { scope: month, accountId, accountName: null, status: 'running', invoices: [], errors: [] };
  await saveState(folder, state);

  const context = await openBrowser({ headless: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await goto(page, MANAGER);
    await page.locator('a[href*="/account/@"]').first().waitFor({ timeout: WAIT_MS });
    const accountLink = page.locator(`a[href$="/account/${accountId}"]`);
    if ((await accountLink.count()) !== 1) throw new Error(`Account ${accountId} not in the account list`);
    state.accountName = (await accountLink.innerText()).trim();

    const billing = await readBilling(page, accountId, state.accountName);
    if (billing.pages > 1) state.errors.push(`Billing has ${billing.pages} pages; this test only reads page 1`);

    const inMonth = billing.rows.filter((row) => {
      const date = parseSiteDate(row.Date ?? '');
      if (!date) state.errors.push(`Unreadable row date: "${row.Date}"`);
      return date?.year === year && date?.month === monthNumber;
    });
    state.rowsOnPage = billing.rows.length;
    state.rowsInMonth = inMonth.length;
    await saveState(folder, state);

    // Earliest payment first, so (2), (3) follow payment-date order.
    inMonth.sort((a, b) => parseSiteDate(a.Date).day - parseSiteDate(b.Date).day);

    let stored = 0;
    for (const row of inMonth) {
      const txId = /\/invoice\/(\d+)/.exec(row.detailsUrl ?? '')?.[1];
      const invoice = { txId, date: row.Date, description: row.Description, amount: money(row['Amount (tax included)'] ?? ''), paymentStatus: row['Payment status'], verified: false };
      state.invoices.push(invoice);
      try {
        if (!txId) throw new Error('Row has no Details link');
        if (invoice.paymentStatus !== 'Paid') { invoice.result = 'not paid'; continue; }

        const details = await readInvoicePage(page, row, accountId, txId);
        Object.assign(invoice, { invoiceStatus: details.status, detailsDate: details.paymentDate });
        if (details.status !== 'Issued') { invoice.result = 'pending issuance'; continue; }
        if (details.amount !== invoice.amount) throw new Error(`Amount differs: billing ${invoice.amount}, details ${details.amount}`);
        if (details.item !== invoice.description) throw new Error(`Item differs: billing "${invoice.description}", details "${details.item}"`);

        const path = join(folder, 'downloads', `${txId}.pdf`);
        Object.assign(invoice, await downloadIssued(context, page, txId, path));
        invoice.downloadedTo = path;
        await saveState(folder, state);

        if (!(await readFile(path)).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Downloaded file is not a PDF');
        const text = await pdfText(path);
        await writeFile(`${path}.txt`, text);
        const site = parseSiteDate(row.Date);
        const pad = (n) => String(n).padStart(2, '0');
        const noSpaces = (s) => s.replace(/\s+/g, '');
        const pdf = {
          transactionId: new RegExp(`Transaction ID:\\n(${txId}(?:_\\w+)?)\\n`).exec(text)?.[1] ?? null,
          paymentDate: /Payment date:\n(\d{4}\.\d{2}\.\d{2})/.exec(text)?.[1] ?? null,
          total: money(/Amount Inc VAT \(THB\)\n(.+)/.exec(text)?.[1] ?? ''),
          invoiceNumber: /Tax Invoice No\.\s*(\S+)/.exec(text)?.[1] ?? null,
          buyerName: /Customer:\n(.+)/.exec(text)?.[1] ?? null,
          itemFound: noSpaces(text).includes(noSpaces(invoice.description)),
        };
        invoice.pdf = pdf;
        const problems = [
          !pdf.transactionId && 'transaction ID',
          pdf.paymentDate !== `${site.year}.${pad(site.month)}.${pad(site.day)}` && 'payment date',
          pdf.total !== invoice.amount && 'total',
          !pdf.itemFound && 'item',
          !pdf.invoiceNumber && 'invoice number',
          !pdf.buyerName && 'buyer name',
        ].filter(Boolean);
        if (problems.length) throw new Error(`PDF check failed: ${problems.join(', ')}`);
        invoice.result = 'verified';
        invoice.verified = true;

        stored += 1;
        const suffix = stored > 1 ? ` (${stored})` : '';
        invoice.storedAs = join(folder, `${safeName(state.accountName)} ${year} ${monthName}${suffix}.pdf`);
        await copyFile(path, invoice.storedAs);
      } catch (err) {
        invoice.result = 'error';
        invoice.error = err.message;
        state.errors.push(`${txId}: ${err.message}`);
      }
      await saveState(folder, state);
    }

    state.status = state.errors.length ? 'unresolved' : inMonth.length ? 'completed' : 'no matching invoices';
    return state.errors.length ? 1 : 0;
  } catch (err) {
    state.status = err instanceof NotLoggedIn ? 'blocked: not logged in' : 'blocked';
    state.errors.push(err.message);
    throw err;
  } finally {
    await saveState(folder, state);
    await context.close();
    console.log(JSON.stringify({ folder, ...state }, null, 2));
  }
}

const [command, arg, arg2] = process.argv.slice(2);
const commands = { login, check, inspect: () => inspect(arg), run: () => run(arg, arg2) };

if (!commands[command]) {
  console.log('Use: node spike.mjs login | check | inspect [@account-id] | run @account-id 2026-10');
  process.exit(1);
}
try {
  process.exit(await commands[command]());
} catch (err) {
  if (err instanceof NotLoggedIn) {
    console.log(`NOT LOGGED IN: ${err.message}`);
    process.exit(2);
  }
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
