# LINE OA Invoice Automation

Downloads and verifies tax invoices from LINE Official Account Manager using Claude Code and a Playwright script.

## For the accountant: how to start

1. Install [Claude Code](https://claude.com/claude-code), [Git](https://git-scm.com/downloads), and [Google Chrome](https://www.google.com/chrome/).
2. Open Claude Code and paste this:

   > Clone https://github.com/Nook-Itthipatpol/line-oa-invoice-automation into my Documents folder. Then read its CLAUDE.md and follow it.

3. Claude will check Node.js, install what is needed, and open Chrome so you can log in to LINE yourself. After that, tell Claude the month you want.

Next time: open Claude Code **inside the cloned folder** and say which month you want.

## Safety

- Your LINE login is saved only on your computer, in `.browser-profile/`. Never share or commit it.
- Downloaded invoices are saved in `output/`. This folder is also never committed.
- The script never types your password and never touches the withholding tax refund form.

See `CLAUDE.md` for the full instructions Claude follows, and what has not been tested yet.
