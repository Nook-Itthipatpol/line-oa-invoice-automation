# LINE OA invoice download (test version)

Downloads and verifies tax invoices from LINE Official Account Manager (https://manager.line.biz/) using a Playwright script.

The user is not technical. Speak Thai, avoid jargon, and give one step at a time. Run the commands yourself.

## Setup (first time only)
1. Check `node --version`. If Node is missing, guide the user to install the LTS version from nodejs.org.
2. Check that Google Chrome is installed. The script uses it, not a bundled browser.
3. Run `npm install`.
4. Run `node spike.mjs login` in the background. Chrome opens and the user logs in by hand. It closes itself once login succeeds (10-minute limit).

## Commands
| Command | Purpose |
|---|---|
| `node spike.mjs login` | Manual login; saves the session |
| `node spike.mjs check` | Is the saved login still valid? |
| `node spike.mjs inspect` | Lists accounts in `output/inspect/accounts.json` (under `links`; IDs look like `@abc1234`) |
| `node spike.mjs run @id YYYY-MM` | Downloads and verifies one account's invoices for one month |

Exit codes: 0 = OK, 1 = error or unresolved work, 2 = not logged in.

## Each run
1. Ask the user to confirm the month and year.
2. Run `check`. If it reports not logged in, run `login` again.
3. Run `inspect` to get the accounts, including those on the free plan, which can still have invoices.
4. Run `run` for every account, one at a time. Never run them in parallel.
5. Report one row per account in Thai: name, status, invoice number, transaction ID, payment date, total, buyer name and any issues. Give the folder path.

Each `run` prints its results and creates its own folder in `output/`. Verified PDFs are named `[account name] [year] [month].pdf`. Status meanings:
- `completed`: every invoice for the month was verified.
- `no matching invoices`: the billing page loaded and nothing matched.
- `unresolved` or `blocked`: not finished. Never report this as "no invoices".

## Rules
- Never type, ask for or store the user's password, and never attempt to get past a security check. The user handles login and security checks.
- Never submit or touch the withholding tax refund form, which is on the invoice page. Do not change LINE settings.
- Do not guess invoice or download URLs. Do not bypass failed checks to mark an invoice verified.
- `.browser-profile/` holds the login, and `output/` holds financial documents. Never share, zip or commit either one.
- Do not edit the script unless the user asks. If LINE's pages have changed, explain the problem first.

## Not tested yet
Tell the user if one of these comes up, and check the results by hand:
- Billing history with several pages. The script reports `unresolved` and reads page 1 only.
- Several invoices for one account in a month, or a pending invoice.
- How long the login lasts.
- LINE's terms on automated access have not been reviewed.
