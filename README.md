# La Casa De Los Trucos – Ordering System

A browser program for building supplier orders, tracking invoices, and planning reorders.
It runs on a desktop computer and on the **rabbit r1** (compact layout).

## Files

| File | What it is |
|---|---|
| `index.html` | The program (open this) |
| `app.js` | Program code |
| `styles.css` | Look and layout (desktop + r1 compact) |
| `xlsx.full.min.js` | Excel export library |
| `logo.png` | Your logo (also used as the r1 icon) |
| `install.html` | Shows the QR code to install the program on the r1 |
| `qrcode.js` | QR code library used by `install.html` (MIT license) |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |
| `items.csv`, `2026.csv` | *Optional* – inventory and this year's sales (see the privacy note) |
| `backup.json` | *Optional, temporary* – companies and orders to load on the r1 (see below) |

## Put it on GitHub Pages

1. Create a repository on GitHub and upload all the files above (drag them onto the repository page, then **Commit changes**).
2. Go to **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
3. After a minute the site address appears at the top of that page, for example
   `https://YOUR-NAME.github.io/YOUR-REPO/`.

## Install on the rabbit r1

1. On a computer, open `https://YOUR-NAME.github.io/YOUR-REPO/install.html`.
2. On the r1, open **creations → add via QR code** and scan the code.
3. Open the creation. It switches to the compact layout by itself.

**After you change any file**, raise the *Version* number on the install page and scan the new code. The r1 keeps using the old copy until you do.

### Using it on the r1

- The bar at the bottom switches between **Companies**, **Items**, **Order** and **More** (settings and backups).
- **Scroll wheel** scrolls the screen. **Side button** presses the main button of any open window (for example *Add* in the Add to Order window).
- Tap an item to add it to the order.

## Getting your data onto the r1

Each device keeps its own data in its own browser. The r1 can't open files, so:

- **Inventory:** if `items.csv` and `2026.csv` are in the repository, the r1 loads them the first time it opens.
- **Companies and orders:** on the computer use **Export Backup**, rename the file to `backup.json`, upload it to the repository, then on the r1 go to **More → Data → Load backup from website** and choose **Merge**.
  When that's done, **delete `backup.json` from the repository**.

To bring orders made on the r1 back to the computer, do the reverse: on the r1 nothing can be downloaded, so build big orders on the computer and use the r1 for quick checks and small orders, or re-enter them.

## Privacy – please read

A GitHub Pages site is **public**: anyone who knows or guesses the address can open the program files **and any data files in the repository**. On GitHub's free plan, Pages only works with public repositories; on the paid plans the published site is still public (only GitHub Enterprise can make it private).

- `items.csv` / `2026.csv` reveal your costs, suppliers and sales.
- `backup.json` reveals your companies, contacts, invoices and orders.

Your orders themselves are **not** uploaded by the program; they stay inside each device's browser. Only files you put in the repository are public.

## Screen layout

**Settings → General → Screen layout**

- **Automatic** – compact on very small screens (like the r1), desktop everywhere else.
- **Desktop** – always the full layout.
- **r1 compact** – always the compact layout.
