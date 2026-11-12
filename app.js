// ==================== DATABASE (IndexedDB) ====================
const DB_NAME = 'OrderingSystemDB';
const DB_VERSION = 1;
let db = null;

// Initialize Database
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            
            if (!database.objectStoreNames.contains('companies')) {
                database.createObjectStore('companies', { keyPath: 'id', autoIncrement: true });
            }
            if (!database.objectStoreNames.contains('items')) {
                database.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
            }
            if (!database.objectStoreNames.contains('orders')) {
                database.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
            }
        };
    });
}

// Load CSV file from disk
async function loadCSVFile(filename) {
    try {
        const response = await fetch(filename);
        if (!response.ok) {
            throw new Error(`Failed to load ${filename}`);
        }
        return await response.text();
    } catch (error) {
        console.error('Error loading CSV:', error);
        return null;
    }
}

// ==================== MANUAL CSV UPLOAD ====================
// FIX: the file type now comes from WHICH button was used (not the file name),
// items are matched by SKU (same rule as the automatic load), and a new sales
// file resets the old year's Qty Sold / Sales so last year's numbers don't linger.
async function handleCSVUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const isItemsFile = event.target.id === 'csv-upload-items';
        showToast(`Processing ${file.name}...`, 'info');

        const parsedData = isItemsFile ? parseItemsCSV(text) : parseCSV(text);
        if (parsedData.length === 0) {
            showToast('No usable data found in file. Check the column headers.', 'error');
            event.target.value = '';
            return;
        }

        const existingItems = await getAll('items');

        // FIX: items.csv is the COMPLETE list, so it now REPLACES the inventory.
        // Before, old rows from the earlier (broken) import stayed in the browser
        // next to the new ones, so you could still see the old wrong On Hand.
        if (isItemsFile) {
            const oldByKey = new Map();
            existingItems.forEach(it => oldByKey.set(inventoryKey(it), it));
            const fresh = new Map();
            const costUp = []; let costDown = 0;
            parsedData.forEach(it => {
                const old = oldByKey.get(inventoryKey(it));
                // NEW: cost change alerts
                if (old && Number(old.cost) > 0 && Number(it.cost) > 0) {
                    const diff = Number(it.cost) - Number(old.cost);
                    if (diff > 0.004) costUp.push({ sku: it.sku, supplier: it.supplier, description: it.description,
                        old: Number(old.cost), now: Number(it.cost), pct: diff / Number(old.cost) * 100 });
                    else if (diff < -0.004) costDown++;
                }
                fresh.set(inventoryKey(it), {
                    sku: it.sku, supplier: it.supplier, description: it.description,
                    onHand: it.onHand, lastSold: it.lastSold, cost: it.cost,
                    // keep this year's sales numbers only if the old row had a real SKU match
                    qtySold: old && old.sku ? (old.qtySold || 0) : 0,
                    sales: old && old.sku ? (old.sales || 0) : 0,
                    ...(old && old.casePack ? { casePack: old.casePack } : {})   // NEW: keep case packs
                });
            });
            // keep items you added by hand with "+ Custom Item"
            existingItems.filter(it => it.custom).forEach(it => {
                const k = inventoryKey(it);
                if (!fresh.has(k)) { const c = { ...it }; delete c.id; fresh.set(k, c); }
            });
            await clearStore('items');
            await saveBatch('items', Array.from(fresh.values()));
            items = await getAll('items');
            renderInventory();
            showToast(`${file.name}: inventory replaced with ${fresh.size} items. Now upload the sales file.`, 'success');
            event.target.value = '';
            // NEW: list the items whose cost went up (only when there was an inventory to compare with)
            if (existingItems.length) {
                costUp.sort((a, b) => b.pct - a.pct);
                saveCostReport({ date: new Date().toISOString(), file: file.name, up: costUp, downCount: costDown });
                if (costUp.length) showCostChanges();
            }
            return;
        }

        const itemMap = new Map();
        existingItems.forEach(item => itemMap.set(inventoryKey(item), item));

        // New sales year: clear the old sales figures first
        if (!isItemsFile) {
            existingItems.forEach(item => { item.qtySold = 0; item.sales = 0; });
        }

        const touched = new Set();
        for (const item of parsedData) {
            const key = inventoryKey(item);
            const existing = itemMap.get(key);

            if (existing) {
                if (isItemsFile) {
                    if (item.sku) existing.sku = item.sku;
                    if (item.supplier) existing.supplier = item.supplier;
                    if (item.description) existing.description = item.description;
                    existing.onHand = item.onHand;
                    if (item.lastSold) existing.lastSold = item.lastSold;
                    existing.cost = item.cost;
                } else {
                    existing.qtySold = item.qtySold;
                    existing.sales = item.sales;
                    if (item.lastSold) existing.lastSold = item.lastSold;
                    if (!existing.supplier && item.supplier) existing.supplier = item.supplier;
                    if (item.cost > 0 && !existing.cost) existing.cost = item.cost;
                }
                touched.add(key);
            } else {
                const newItem = {
                    sku: item.sku, supplier: item.supplier, description: item.description,
                    onHand: item.onHand || 0, qtySold: item.qtySold || 0, sales: item.sales || 0,
                    lastSold: item.lastSold || '', cost: item.cost || 0
                };
                itemMap.set(key, newItem);
                touched.add(key);
            }
        }

        // Sales upload saves everything (because the old sales were reset);
        // items upload only saves what changed.
        const batchToSave = isItemsFile
            ? Array.from(touched).map(k => itemMap.get(k))
            : Array.from(itemMap.values());

        await saveBatch('items', batchToSave);
        items = await getAll('items');
        renderInventory();
        showToast(`${file.name}: ${parsedData.length} rows loaded`, 'success');
        event.target.value = '';
    } catch (error) {
        console.error('Manual CSV upload error:', error);
        showToast('Failed to process CSV: ' + error.message, 'error');
        event.target.value = '';
    }
}

async function getAll(storeName) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function add(storeName, data) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.add(data);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function update(storeName, data) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put(data);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ==================== BATCH DB OPERATION (SPEED FIX) ====================
async function saveBatch(storeName, itemsArray) {
    return new Promise((resolve, reject) => {
        if (itemsArray.length === 0) return resolve();

        // Crucial: One single 'readwrite' transaction for all items
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);

        itemsArray.forEach(item => {
            // Using put() ensures existing items are updated by their ID, 
            // and new items are added.
            store.put(item); 
        });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

function clearStore(storeName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction([storeName], 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function deleteRecord(storeName, id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ==================== GLOBAL STATE ====================
const SALES_FILE = '2026.csv';   // change this one line each new year

// FIX: text from the CSV/forms is escaped before it is put on the page
function escapeHtml(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
let companies = [];
let items = [];
let orders = [];
let selectedCompany = null;
let currentOrder = { items: [], subtotal: 0, total: 0 };
let editingCompanyId = null;
let editingOrderId = null;
let editingItemId = null;
let selectedItem = null;
let sortOrder = 'asc';
let editingInvoiceIndex = null;
let editingDiscrepancyIndex = null;
let editingCreditIndex = null;
let selectedYear = new Date().getFullYear();
let editingExternalOrderIndex = null; // NEW: Global index for editing external orders
let searchTimeout = null;
let renderChunkTimeout = null; // Tracks background rendering to cancel it if needed
// FIX: drawing all 65,000 rows froze/crashed the browser. Show 500 at a time.
const INVENTORY_PAGE = 500;
let inventoryLimit = INVENTORY_PAGE;
let lastInventorySearch = '';

// ==================== SAMPLE DATA ====================
const sampleCSV = `SKU,Supplier,Description,On Hand,Quantity Sold,Sales,Last Sold,Cost
SKU001,ABC Suppliers,Premium Widget A,150,45,2250.00,2025-01-15,50.00
SKU002,XYZ Corp,Deluxe Gadget B,200,80,4800.00,2025-01-20,60.00
SKU003,ABC Suppliers,Standard Tool C,300,120,3600.00,2025-01-10,30.00
SKU004,Global Parts,Heavy Component D,75,25,3750.00,2025-01-18,150.00
SKU005,XYZ Corp,Compact Device E,500,200,6000.00,2025-01-22,30.00
SKU006,TechPro Ltd,Professional Kit F,100,35,5250.00,2025-01-12,150.00`;

const sampleCompanies = [
    { name: 'Acme Corp', address: '123 Business St, NY 10001', rep: 'John Smith', phone: '(555) 123-4567', customerNumber: 'CUST001', email: 'john@acme.com', notes: 'Preferred customer', discrepancies: [], invoices: [], creditMemos: [] },
    { name: 'Tech Solutions', address: '456 Innovation Ave, SF 94102', rep: 'Sarah Johnson', phone: '(555) 234-5678', customerNumber: 'CUST002', email: 'sarah@tech.com', notes: 'Net 30 terms', discrepancies: [], invoices: [], creditMemos: [] },
    { name: 'Global Enterprises', address: '789 Commerce Blvd, Chicago 60601', rep: 'Mike Chen', phone: '(555) 345-6789', customerNumber: 'CUST003', email: 'mike@global.com', notes: 'Bulk discounts', discrepancies: [], invoices: [], creditMemos: [] }
];

// ==================== INITIALIZATION (FIXED ORDER & SPEED) ====================
window.addEventListener('DOMContentLoaded', async () => {
    try {
        await initDB();
        
        companies = await getAll('companies');
        items = await getAll('items');
        orders = await getAll('orders');
        
        // Seed sample companies if empty
        if (companies.length === 0) {
            for (const company of sampleCompanies) {
                await add('companies', company);
            }
            companies = await getAll('companies');
        }
        
        // Load CSV files only if items database is empty (FIXED LOGIC AND SPEED)
        if (items.length === 0) {
            showToast('Loading inventory data automatically...', 'info');
            
            // 1. Load Sales Data (2026.csv) - FIX: was still pointing at 2025.csv
            const salesCSV = await loadCSVFile(SALES_FILE);
            const salesData = salesCSV ? parseCSV(salesCSV) : [];
            
            // 2. Load Inventory Data (items.csv) - Completes and updates info
            // Ensure parseItemsCSV is using the robust version from previous steps!
            const itemsCSV = await loadCSVFile('items.csv');
            const itemsData = itemsCSV ? parseItemsCSV(itemsCSV) : [];
            
            // 3. Merge the data (Correctness Fix)
            const mergedItems = mergeInventoryData(salesData, itemsData);
            
            // 4. FAST BATCH SAVE (SPEED FIX)
            if (mergedItems.length > 0) {
                await saveBatch('items', mergedItems);
                items = await getAll('items');
                showToast(`Loaded ${items.length} items successfully`, 'success');
            } else {
                showToast('CSV files not found. Please upload them manually.', 'error');
            }
        }
        
        // FIX: Order Date box was blank on start-up
        document.getElementById('order-date').valueAsDate = new Date();

        // Final UI Renders
        renderCompanies();
        renderInventory();
        updateStats();
        populateYearFilters();
        renderOrdersLedger();
        checkOrderDraft();   // NEW: offer to restore an autosaved order
        startAutosave();     // NEW: timer follows Settings (on/off, minutes)

    } catch (error) {
        console.error('Init error:', error);
        showToast('Failed to initialize', 'error');
    }
});

// ==================== CSV PARSING ====================
// FIX: one shared tokenizer. It also re-joins rows that the POS export split
// in two (an unquoted line break inside a cell), which is what was shifting
// columns in items.csv and 2026.csv.
function tokenizeCSV(csvText) {
    csvText = csvText.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, ' ');
    const rows = [];
    let current = '', insideQuotes = false, currentRow = [];

    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];
        if (char === '"') {
            // FIX: a quote only starts a quoted cell at the beginning of the cell.
            // A stray inch mark like  12" Wig  used to swallow the rest of the file.
            if (insideQuotes) {
                if (csvText[i + 1] === '"') { current += '"'; i++; }
                else insideQuotes = false;
            } else if (current.trim() === '') {
                insideQuotes = true;
            } else {
                current += '"';
            }
        } else if (char === ',' && !insideQuotes) {     // FIX: semicolons are no longer treated as separators
            currentRow.push(current.trim()); current = '';
        } else if (char === '\n' && !insideQuotes) {
            currentRow.push(current.trim());
            rows.push(currentRow);
            currentRow = []; current = '';
        } else {
            current += char;
        }
    }
    if (current.length > 0 || currentRow.length > 0) { currentRow.push(current.trim()); rows.push(currentRow); }

    if (rows.length === 0) return { headers: [], rows: [] };
    const headers = rows.shift();
    const width = headers.length;

    // Re-join broken rows: keep gluing the next line on until the row has all its columns
    const fixed = [];
    for (let i = 0; i < rows.length; i++) {
        let row = rows[i];
        while (row.length < width && i + 1 < rows.length && row.length + rows[i + 1].length - 1 <= width) {
            const next = rows[++i];
            row = row.slice(0, -1).concat([(row[row.length - 1] + ' ' + next[0]).trim()], next.slice(1));
        }
        if (row.some(v => v.length > 0)) fixed.push(row);
    }
    return { headers, rows: fixed };
}

// FIX: looks for each column name IN ORDER OF PREFERENCE.
// The old version took whichever header came first in the file, so in items.csv
// "Price" (column I) was used as Cost because it sits before "Cost" (column K).
function makeColumnFinder(headers) {
    const norm = headers.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
    return (names) => {
        for (const n of names) {
            const i = norm.indexOf(n);
            if (i > -1) return i;
        }
        return -1;
    };
}

const cleanFloat = (val) => {
    if (val === undefined || val === null || val === '') return 0;
    const num = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
    return isNaN(num) ? 0 : num;
};
const cleanInt = (val) => Math.round(cleanFloat(val));

// Store dates as YYYY-MM-DD so they display cleanly and sort correctly
function normalizeDate(val) {
    if (!val) return '';
    const s = String(val).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return s;
}

const COLS = {
    sku:         ['sku', 'itemlookupcode', 'lookupcode', 'itemnumber', 'item', 'id'],
    supplier:    ['supplier', 'suppliername', 'vendor', 'vendorname', 'mfg'],
    description: ['description', 'desc', 'name', 'title'],
    onHand:      ['onhand', 'qtyonhand', 'quantityonhand', 'stock', 'qty'],
    qtySold:     ['quantitysold', 'qtysold', 'sold'],
    sales:       ['sales', 'revenue'],
    lastSold:    ['lastsold', 'lastsale'],
    cost:        ['cost', 'unitcost', 'purchaseprice']   // FIX: "price" removed — it is the retail price
};

function readRows(csvText, withSales) {
    const { headers, rows } = tokenizeCSV(csvText);
    const find = makeColumnFinder(headers);
    const idx = {};
    for (const k in COLS) idx[k] = find(COLS[k]);
    if (idx.sku < 0 && idx.description < 0) {
        console.warn('CSV headers not recognised:', headers);
        return [];
    }
    const get = (row, k) => (idx[k] > -1 ? (row[idx[k]] || '') : '');

    return rows.map(row => {
        const item = {
            sku: get(row, 'sku').trim(),
            supplier: get(row, 'supplier'),
            description: get(row, 'description'),
            onHand: cleanInt(get(row, 'onHand')),
            lastSold: normalizeDate(get(row, 'lastSold')),
            cost: cleanFloat(get(row, 'cost'))
        };
        if (withSales) {
            item.qtySold = cleanInt(get(row, 'qtySold'));
            item.sales = cleanFloat(get(row, 'sales'));
        }
        return item;
    }).filter(it => it.sku || it.description);   // FIX: skip blank rows (2026.csv line 2 was one)
}

// Sales file (2026.csv)
function parseCSV(csvText) { return readRows(csvText, true); }

// Inventory file (items.csv)
function parseItemsCSV(csvText) { return readRows(csvText, false); }

// ==================== DATA MERGING LOGIC (SKU PRIORITY) ====================
// Same key is used by the automatic load AND the manual upload buttons.
function inventoryKey(item) {
    const sku = (item.sku || '').toString().trim().toLowerCase();
    if (sku) return `sku:${sku}`;
    const sup = (item.supplier || '').toString().trim().toLowerCase();
    const desc = (item.description || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
    return `desc:${sup}|${desc}`;
}

function mergeInventoryData(salesData, itemsData) {
    const inventoryMap = new Map();

    salesData.forEach(item => {
        inventoryMap.set(inventoryKey(item), {
            sku: item.sku || '', supplier: item.supplier, description: item.description,
            onHand: item.onHand || 0, qtySold: item.qtySold, sales: item.sales,
            lastSold: item.lastSold || '', cost: item.cost || 0
        });
    });

    itemsData.forEach(item => {
        const key = inventoryKey(item);
        const existing = inventoryMap.get(key);
        if (existing) {
            if (item.sku) existing.sku = item.sku;
            if (item.supplier) existing.supplier = item.supplier;
            existing.onHand = item.onHand;
            if (item.lastSold > (existing.lastSold || '')) existing.lastSold = item.lastSold;
            existing.cost = item.cost;
            if (item.description && item.description.length > existing.description.length) {
                existing.description = item.description;
            }
        } else {
            inventoryMap.set(key, {
                sku: item.sku || '', supplier: item.supplier, description: item.description,
                onHand: item.onHand, qtySold: 0, sales: 0,
                lastSold: item.lastSold || '', cost: item.cost || 0
            });
        }
    });

    return Array.from(inventoryMap.values());
}

// ==================== TOAST NOTIFICATIONS ====================
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `show ${type}`;
    setTimeout(() => {
        toast.className = '';
    }, 3000);
}

// ==================== COMPANIES ====================
function renderCompanies() {
    const list = document.getElementById('companies-list');
    
    // Sort companies alphabetically by name
    const sortedCompanies = [...companies].sort((a, b) => 
        a.name.localeCompare(b.name)
    );
    // NEW: the selected company comes first, shown in full; the rest show only their name
    const selIndex = sortedCompanies.findIndex(c => c.id === selectedCompany?.id);
    if (selIndex > 0) sortedCompanies.unshift(sortedCompanies.splice(selIndex, 1)[0]);
    
    list.innerHTML = sortedCompanies.map(c => {
        if (selectedCompany?.id !== c.id) {
            return `<div onclick="selectCompany(${c.id})" class="company-chip" title="${escapeHtml(c.customerNumber || '')}">${escapeHtml(c.name)}</div>`;
        }

        // 1. Calculate Outstanding Invoices (Existing Logic)
        const outstandingInvoices = calculateOutstandingInvoices(c);
        
        // 2. Calculate Yearly Order Totals (New Logic: All Years)
        const years = new Set();
        
        // Scan Internal Orders for years
        orders.filter(o => o.companyId === c.id).forEach(o => {
            if (o.date) years.add(new Date(o.date).getFullYear());
        });
        
        // Scan External Orders for years
        if (c.externalOrders) {
            c.externalOrders.forEach(eo => {
                if (eo.date) years.add(new Date(eo.date).getFullYear());
            });
        }
        
        // Ensure current year is always shown even if no data
        if (years.size === 0) years.add(new Date().getFullYear());
        
        // Sort years descending (2025, 2024, 2023...)
        const sortedYears = Array.from(years).sort((a, b) => b - a);
        
        // Generate HTML for each year's total
        const ordersByYearHTML = sortedYears.map(year => {
            const total = getYearlyTotal(c.id, year);
            return `<div class="company-total">${year}: $${total.toFixed(2)}</div>`;
        }).join('');

        // 3. Format Credit Memos (New Logic: Amount and Date)
        let creditsHTML = '';
        if (c.creditMemos && c.creditMemos.length > 0) {
            // Sort credits by date descending (Newest first)
            const sortedCredits = [...c.creditMemos].sort((a, b) => 
                new Date(b.date) - new Date(a.date)
            );

            creditsHTML = sortedCredits.map(cm => {
                const dateStr = cm.date ? new Date(cm.date).toLocaleDateString() : 'N/A';
                // Visual: Green text to indicate credit
                return `<div class="company-total" style="color: #059669; font-size: 0.85em;">Credit: $${cm.amount.toFixed(2)} (${dateStr})</div>`;
            }).join('');
        }

        return `
        <div class="selected">
            <div class="company-card-top">
                <div class="company-name">${escapeHtml(c.name)}</div>
                <button class="btn-sm" onclick="event.stopPropagation(); clearCompanySelection();" title="Close this company">Close</button>
            </div>
            <div class="company-number">${escapeHtml(c.customerNumber)}</div>
            
            ${ordersByYearHTML}
            
            <div class="company-total" style="color:var(--danger);">Outstanding invoices: $${outstandingInvoices.toFixed(2)}</div>
            
            ${creditsHTML}
            
            <div class="company-actions">
                <button class="btn-edit" onclick="event.stopPropagation(); editCompany(${c.id})">Edit</button>
                <button class="btn-delete" onclick="event.stopPropagation(); deleteCompany(${c.id})">Delete</button>
            </div>
        </div>
    `}).join('');

    renderInvoiceAlerts();   // NEW: overdue / due-soon invoices banner
}

function calculateOutstandingInvoices(company) {
    if (!company.invoices || company.invoices.length === 0) return 0;
    
    return company.invoices.reduce((total, inv) => {
        if (inv.status === 'Outstanding') {
            return total + inv.amount;
        }
        return total;
    }, 0);
}

function selectCompany(id) {
    selectedCompany = companies.find(c => c.id === id);
    renderCompanies(); // Refreshes the list to show selection highlight
    
    if (selectedCompany) {
        updateBuilderStatus();   // company name + saved / unsaved state
        document.getElementById('save-btn').disabled = currentOrder.items.length === 0;

        const details = document.getElementById('company-details');
        details.classList.remove('hidden');

        // We populate the year filters first
        populateCompanyYearFilters();
        
        // Then render all sections (Info, Orders, Invoices, etc.)
        renderCompanySections();

        // NEW: Reorder tab follows the selected company
        populateReorderSuppliers();
        renderOrderThresholds();
        populateSupplierFilters();
        if (document.getElementById('inv-supplier-filter')?.value === '__company') filterItems(true);
        if (!document.getElementById('dead-content').classList.contains('hidden')) renderDeadStock();
        if (!document.getElementById('reorder-content').classList.contains('hidden')) renderReorder();
    }
}

function populateCompanyYearFilters() {
    const years = new Set();
    
    // Get years from orders
    orders.filter(o => o.companyId === selectedCompany.id).forEach(o => {
        years.add(new Date(o.date).getFullYear());
    });
    
    // Get years from invoices
    if (selectedCompany.invoices) {
        selectedCompany.invoices.forEach(inv => {
            if (inv.date) years.add(new Date(inv.date).getFullYear());
        });
    }
    
    // Get years from discrepancies
    if (selectedCompany.discrepancies) {
        selectedCompany.discrepancies.forEach(d => {
            if (d.date) years.add(new Date(d.date).getFullYear());
        });
    }
    
    // Get years from credit memos
    if (selectedCompany.creditMemos) {
        selectedCompany.creditMemos.forEach(cm => {
            if (cm.date) years.add(new Date(cm.date).getFullYear());
        });
    }
    
    // Add current year if no data
    if (years.size === 0) {
        years.add(new Date().getFullYear());
    }
    
    const sortedYears = Array.from(years).sort((a, b) => b - a);
    
    // Create year selects
    ['orders', 'invoices', 'discrepancies', 'credits'].forEach(type => {
        const selectId = `${type}-year-filter`;
        const select = document.getElementById(selectId);
        if (select) {
            select.innerHTML = sortedYears.map(y => 
                `<option value="${y}" ${y === selectedYear ? 'selected' : ''}>${y}</option>`
            ).join('');
        }
    });
}

function renderCompanySections() {
    if (!selectedCompany) return;

    // --- 1. READ CURRENT DROPDOWN VALUES (Preserve selection) ---
    // If the element doesn't exist yet (first load), default to global 'selectedYear'
    const orderYear = parseInt(document.getElementById('orders-year-filter')?.value || selectedYear);
    const invYear = parseInt(document.getElementById('invoices-year-filter')?.value || selectedYear);
    const discYear = parseInt(document.getElementById('discrepancies-year-filter')?.value || selectedYear);
    const credYear = parseInt(document.getElementById('credits-year-filter')?.value || selectedYear);

    // --- 2. HELPER: GENERATE YEAR OPTIONS ---
    // We generate the dropdown options dynamically so they always include new years
    const getOptions = (items, dateField, currentSelection) => {
        const years = new Set([new Date().getFullYear()]); // Always include current year
        items.forEach(item => {
            if (item[dateField]) years.add(new Date(item[dateField]).getFullYear());
        });
        return Array.from(years).sort((a, b) => b - a).map(y => 
            `<option value="${y}" ${y === currentSelection ? 'selected' : ''}>${y}</option>`
        ).join('');
    };

    // --- 3. HELPER: CARD LAYOUT ---
    const createCard = (title, meta, actions) => `
        <div class="record-card">
            <div class="record-header">${title}</div>
            <div class="record-meta">${meta}</div>
            <div class="record-actions">${actions}</div>
        </div>
    `;

    // --- 4. GENERATE CONTENT STRINGS ---

    // Info Section
    // FIX: empty fields showed "undefined"
    const val = v => (v === undefined || v === null || String(v).trim() === '') ? '<span class="muted">Not set</span>' : escapeHtml(v);
    const money0 = v => Number(v) > 0 ? '$' + Number(v).toFixed(2) : '<span class="muted">Not set</span>';
    const c0 = selectedCompany;
    const infoHTML = `
        <div class="info-grid">
            <div class="info-item"><span>Representative</span><div>${val(c0.rep)}</div></div>
            <div class="info-item"><span>Phone</span><div>${val(c0.phone)}</div></div>
            <div class="info-item"><span>Email</span><div>${c0.email ? `<a href="mailto:${escapeHtml(c0.email)}">${escapeHtml(c0.email)}</a>` : val('')}</div></div>
            <div class="info-item"><span>Address</span><div>${val(c0.address)}</div></div>
            <div class="info-item"><span>Payment terms</span><div>${termsLabel(c0.termsDays) || '<span class="muted">Not set</span>'}</div></div>
            <div class="info-item"><span>Minimum order</span><div>${money0(c0.minOrder)}</div></div>
            <div class="info-item"><span>Free shipping at</span><div>${money0(c0.freeFreight)}</div></div>
            <div class="info-item"><span>Inventory supplier</span><div>${val(supplierForCompany(c0))}</div></div>
            ${c0.notes ? `<div class="info-item wide"><span>Notes</span><div>${escapeHtml(c0.notes)}</div></div>` : ''}
        </div>
    `;

   // Orders (Internal and External - Modified logic)
    const companyOrders = orders.filter(o => o.companyId === selectedCompany.id);
    const externalOrders = selectedCompany.externalOrders || []; // NEW: Get external orders
    
    // Combine all items that have a date property for year filtering
    const allOrderRecords = [...companyOrders, ...externalOrders]; 

    const orderOptions = getOptions(allOrderRecords, 'date', orderYear);
    
    // Combined HTML for internal orders
    let ordersHTML = companyOrders
        .filter(o => new Date(o.date).getFullYear() === orderYear)
        .map(o => createCard(
            `[Internal] Order #${o.id} - $${o.total.toFixed(2)} ${statusBadge(o)}`, 
            `Date: ${new Date(o.date).toLocaleDateString()}${o.poNumber ? ` · ${escapeHtml(o.poNumber)}` : ''}<br>Items: ${o.items.length}`, 
            `<button onclick="loadOrder(${o.id})" class="btn-edit">Edit</button>
             <button onclick="showReceiveModal(${o.id})" class="btn-receive">Receive</button>
             <button onclick="printSavedPO(${o.id})">Print PO</button>
             <button onclick="emailSavedPO(${o.id})">Email</button>`
        )).join('');
        
    // HTML for external orders (NEW)
    ordersHTML += externalOrders
        .filter(eo => eo.date && new Date(eo.date).getFullYear() === orderYear)
        .map((eo, i) => {
            const originalIndex = externalOrders.indexOf(eo);
            const meta = `PO: ${eo.poNumber}<br>Date: ${new Date(eo.date).toLocaleDateString()}`;
            const actions = `
                <button onclick="editExternalOrder(${selectedCompany.id}, ${originalIndex})" class="btn-edit">Edit</button>
                <button onclick="deleteExternalOrder(${selectedCompany.id}, ${originalIndex})" class="btn-delete">Delete</button>
            `;
            return createCard(`[External] $${eo.amount.toFixed(2)}`, meta, actions);
        }).join('');
        
    if (ordersHTML === '') {
        ordersHTML = '<div class="empty">No orders for this year</div>';
    }

    // Invoices
    const invoices = selectedCompany.invoices || [];
    const invoiceOptions = getOptions(invoices, 'date', invYear);
    
    const invoicesHTML = invoices
        .filter(inv => inv.date && new Date(inv.date).getFullYear() === invYear)
        .map((inv, i) => {
            const originalIndex = invoices.indexOf(inv);
            const statusColor = inv.status === 'Paid' ? '#059669' : '#dc2626';
            const meta = `
                Status: <span class="clickable-status" style="color:${statusColor}" onclick="toggleInvoiceStatus(${selectedCompany.id}, ${originalIndex})">${inv.status}</span><br>
                Due: ${inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : 'N/A'}
                ${inv.paidDate ? `<br>Paid: ${new Date(inv.paidDate).toLocaleDateString()}` : ''}
                ${inv.paymentMethod ? ` (${inv.paymentMethod})` : ''}
            `;
            const actions = `
                <button onclick="editInvoice(${selectedCompany.id}, ${originalIndex})" class="btn-edit">Edit</button>
                <button onclick="deleteInvoice(${selectedCompany.id}, ${originalIndex})" class="btn-delete">Delete</button>
            `;
            return createCard(`${inv.number} - $${inv.amount.toFixed(2)}`, meta, actions);
        }).join('') || '<div class="empty">No invoices for this year</div>';

    // Discrepancies
    const discrepancies = selectedCompany.discrepancies || [];
    const discOptions = getOptions(discrepancies, 'date', discYear);

    const discrepanciesHTML = discrepancies
        .filter(d => d.date && new Date(d.date).getFullYear() === discYear)
        .map((d, i) => {
            const originalIndex = discrepancies.indexOf(d);
            const actions = `
                <button onclick="editDiscrepancy(${selectedCompany.id}, ${originalIndex})" class="btn-edit">Edit</button>
                <button onclick="deleteDiscrepancy(${selectedCompany.id}, ${originalIndex})" class="btn-delete">Delete</button>
            `;
            return createCard(d.description, new Date(d.date).toLocaleDateString(), actions);
        }).join('') || '<div class="empty">No discrepancies for this year</div>';

    // Credit Memos
    const credits = selectedCompany.creditMemos || [];
    const credOptions = getOptions(credits, 'date', credYear);

    const creditsHTML = credits
        .filter(cm => cm.date && new Date(cm.date).getFullYear() === credYear)
        .map((cm, i) => {
            const originalIndex = credits.indexOf(cm);
            const meta = `
                Status: <span class="clickable-status" onclick="toggleCreditStatus(${selectedCompany.id}, ${originalIndex})">${cm.applied ? 'Applied' : 'Unapplied'}</span>
                ${cm.date ? `<br>Date: ${new Date(cm.date).toLocaleDateString()}` : ''}
                ${cm.appliedDate ? `<br>Applied: ${new Date(cm.appliedDate).toLocaleDateString()}` : ''}
            `;
            const actions = `
                <button onclick="editCredit(${selectedCompany.id}, ${originalIndex})" class="btn-edit">Edit</button>
                <button onclick="deleteCredit(${selectedCompany.id}, ${originalIndex})" class="btn-delete">Delete</button>
            `;
            return createCard(`${cm.description} - $${cm.amount.toFixed(2)}`, meta, actions);
        }).join('') || '<div class="empty">No credit memos for this year</div>';

    // --- 5. INJECT ALL HTML AT ONCE ---
    // We inject everything into the main container. This prevents the "element is null" error.
    const section = (title, id, filterId, options, addLabel, addFn, body) => `
        <div class="section-box">
            <div class="section-head">
                <h4>${title}</h4>
                <div class="section-controls">
                    <select id="${filterId}" onchange="renderCompanySections()" title="Year">${options}</select>
                    <button onclick="${addFn}" class="btn-add">${addLabel}</button>
                </div>
            </div>
            <div class="section-body" id="${id}">${body}</div>
        </div>`;

    document.getElementById('company-details').innerHTML = `
        <div class="details-head">
            <h3>${escapeHtml(selectedCompany.name)} · Details</h3>
        </div>
        <div id="company-info">${infoHTML}</div>
        <div class="sections-grid">
            ${section(`Orders <small>· ${orderYear} total $${getYearlyTotal(selectedCompany.id, orderYear).toFixed(2)}</small>`, 'company-orders', 'orders-year-filter', orderOptions, '+ External', 'showExternalOrderModal()', ordersHTML)}
            ${section('Invoices', 'company-invoices', 'invoices-year-filter', invoiceOptions, '+ Add', 'showInvoiceModal()', invoicesHTML)}
            ${section('Discrepancies', 'company-discrepancies', 'discrepancies-year-filter', discOptions, '+ Add', 'showDiscrepancyModal()', discrepanciesHTML)}
            ${section('Credit Memos', 'company-credits', 'credits-year-filter', credOptions, '+ Add', 'showCreditModal()', creditsHTML)}
        </div>
    `;
}

// ==================== EXTERNAL ORDERS ====================

function showExternalOrderModal() {
    if (!selectedCompany) return showToast('Select a company first', 'error');
    editingExternalOrderIndex = null;
    document.getElementById('external-order-modal').classList.add('show');
    document.getElementById('external-order-modal-title').textContent = 'Add External Order';
    document.getElementById('eo-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('eo-po').value = '';
    document.getElementById('eo-amount').value = '';
}

function editExternalOrder(companyId, index) {
    const company = companies.find(c => c.id === companyId);
    if (!company || !company.externalOrders || !company.externalOrders[index]) return;
    
    selectedCompany = company;
    editingExternalOrderIndex = index;
    const order = company.externalOrders[index];

    document.getElementById('external-order-modal').classList.add('show');
    document.getElementById('external-order-modal-title').textContent = 'Edit External Order';
    document.getElementById('eo-date').value = order.date ? order.date.split('T')[0] : '';
    document.getElementById('eo-po').value = order.poNumber;
    document.getElementById('eo-amount').value = order.amount;
}

async function saveExternalOrder() {
    const date = document.getElementById('eo-date').value;
    const poNumber = document.getElementById('eo-po').value.trim();
    const amount = parseFloat(document.getElementById('eo-amount').value);

    if (!date || !poNumber || isNaN(amount) || amount <= 0) {
        showToast('Fill all fields (Date, PO, Amount > 0)', 'error');
        return;
    }
    
    // FIX: Append T12:00:00 to prevent timezone shift
    const orderData = {
        date: new Date(date + 'T12:00:00').toISOString(),
        poNumber: poNumber,
        amount: amount
    };

    selectedCompany.externalOrders = selectedCompany.externalOrders || [];
    
    if (editingExternalOrderIndex !== null) {
        selectedCompany.externalOrders[editingExternalOrderIndex] = orderData;
        showToast('External Order updated', 'success');
    } else {
        selectedCompany.externalOrders.push(orderData);
        showToast('External Order added', 'success');
    }

    try {
        await update('companies', selectedCompany);
        
        // Refresh global state and UI elements
        companies = await getAll('companies');
        selectCompany(selectedCompany.id); // Re-renders company details
        renderCompanies(); // Re-renders company list (to update year total)
        updateStats(); // Re-renders bottom ledger stats
        populateYearFilters();
        renderOrdersLedger(); // ADDED: Refresh ledger total if looking at it
        closeModal('external-order-modal');
        
    } catch (error) {
        showToast('Failed to save external order', 'error');
    }
}

async function deleteExternalOrder(companyId, index) {
    if (!confirm('Delete this external order?')) return;
    
    const company = companies.find(c => c.id === companyId);
    if (!company || !company.externalOrders) return;
    
    company.externalOrders.splice(index, 1);
    
    await update('companies', company);
    companies = await getAll('companies');
    
    selectCompany(companyId); // Re-renders company details
    renderCompanies(); // Re-renders company list (to update year total)
    updateStats(); // Re-renders bottom ledger stats
    renderOrdersLedger(); // FIX: ledger still showed the deleted order
    showToast('External order deleted', 'success');
}

function clearCompanySelection() {
    selectedCompany = null;
    editingCompanyId = null;
    
    // Collapse the list back to names only
    renderCompanies();

    // Hide details panel
    document.getElementById('company-details').classList.add('hidden');
    
    // Reset Order Builder Header
    updateBuilderStatus();
    document.getElementById('save-btn').disabled = true;
}

// app.js (In getYearlyTotal, around line 337)

function getYearlyTotal(companyId, year) {
    const company = companies.find(c => c.id === companyId);
    let total = 0;

    // 1. Orders made within the program (Existing logic)
    orders.filter(o => o.companyId === companyId).forEach(order => {
        if (new Date(order.date).getFullYear() === year) {
            total += order.total;
        }
    });
    
    // 2. Orders made outside the program (NEW)
    if (company && company.externalOrders) {
        company.externalOrders.forEach(extOrder => {
            if (new Date(extOrder.date).getFullYear() === year) {
                total += extOrder.amount;
            }
        });
    }

    return total;
}

function showCompanyModal() {
    editingCompanyId = null;
    document.getElementById('company-modal').classList.add('show');
    document.getElementById('c-name').value = '';
    document.getElementById('c-number').value = '';
    document.getElementById('c-address').value = '';
    document.getElementById('c-rep').value = '';
    document.getElementById('c-phone').value = '';
    document.getElementById('c-email').value = '';
    document.getElementById('c-notes').value = '';
    document.getElementById('c-min-order').value = '';
    document.getElementById('c-free-freight').value = '';
    fillTermsInForm('');
}

function editCompany(id) {
    editingCompanyId = id;
    const company = companies.find(c => c.id === id);
    document.getElementById('company-modal').classList.add('show');
    document.getElementById('c-name').value = company.name;
    document.getElementById('c-number').value = company.customerNumber;
    document.getElementById('c-address').value = company.address;
    document.getElementById('c-rep').value = company.rep;
    document.getElementById('c-phone').value = company.phone;
    document.getElementById('c-email').value = company.email;
    document.getElementById('c-notes').value = company.notes;
    document.getElementById('c-min-order').value = company.minOrder || '';
    document.getElementById('c-free-freight').value = company.freeFreight || '';
    fillTermsInForm(company.termsDays);
}

async function saveCompany() {
    const name = document.getElementById('c-name').value.trim();
    const customerNumber = document.getElementById('c-number').value.trim();
    
    if (!name || !customerNumber) {
        showToast('Name and customer number required', 'error');
        return;
    }
    
    const data = {
        name,
        customerNumber,
        address: document.getElementById('c-address').value.trim(),
        rep: document.getElementById('c-rep').value.trim(),
        phone: document.getElementById('c-phone').value.trim(),
        email: document.getElementById('c-email').value.trim(),
        notes: document.getElementById('c-notes').value.trim(),
        minOrder: parseFloat(document.getElementById('c-min-order').value) || 0,
        freeFreight: parseFloat(document.getElementById('c-free-freight').value) || 0,
        termsDays: readTermsFromForm(),
        discrepancies: [],
        invoices: [],
        creditMemos: [],
        externalOrders: [] // NEW: Initialize for new companies
    };
    
    try {
        if (editingCompanyId) {
            data.id = editingCompanyId;
            const existing = companies.find(c => c.id === editingCompanyId);
            data.discrepancies = existing.discrepancies || [];
            data.invoices = existing.invoices || [];
            data.creditMemos = existing.creditMemos || [];
            data.externalOrders = existing.externalOrders || []; 
            // FIX: keep any other saved settings (e.g. which inventory supplier it uses)
            const merged = { ...existing, ...data };
            await update('companies', merged);
            showToast('Company updated', 'success');
        } else {
            await add('companies', data);
            showToast('Company added', 'success');
        }
        
        companies = await getAll('companies');
        if (selectedCompany) selectCompany(selectedCompany.id); else renderCompanies();
        renderOrderThresholds();
        updateStats();
        closeModal('company-modal');
    } catch (error) {
        showToast('Failed to save company', 'error');
    }
}

async function deleteCompany(id) {
    if (!confirm('Delete this company AND all of its saved orders?')) return;
    
    try {
        await deleteRecord('companies', id);
        // FIX: remove its orders too, they were left behind in the Ledger
        for (const o of orders.filter(o => o.companyId === id)) {
            await deleteRecord('orders', o.id);
        }
        orders = await getAll('orders');
        renderOrdersLedger();
        companies = await getAll('companies');
        if (selectedCompany?.id === id) {
            selectedCompany = null;
            document.getElementById('company-details').classList.add('hidden');
        }
        renderCompanies();
        updateStats();
        showToast('Company deleted', 'success');
    } catch (error) {
        showToast('Failed to delete', 'error');
    }
}

// ==================== INVOICES ====================
function showInvoiceModal() {
    if (!selectedCompany) return showToast('Select a company first', 'error');
    editingInvoiceIndex = null;
    document.getElementById('invoice-modal').classList.add('show');
    document.getElementById('invoice-modal-title').textContent = 'Add Invoice';
    document.getElementById('inv-number').value = '';
    document.getElementById('inv-amount').value = '';
    document.getElementById('inv-due-date').value = '';
    document.getElementById('inv-status').value = 'Outstanding';
    document.getElementById('inv-paid-date').value = '';
    document.getElementById('inv-payment-method').value = '';
    document.getElementById('inv-paid-date').disabled = true;
    document.getElementById('inv-payment-method').disabled = true;
    // NEW: due date from the company's payment terms
    const hint = document.getElementById('inv-terms-hint');
    const t = termsLabel(selectedCompany.termsDays);
    if (t) {
        document.getElementById('inv-due-date').value = addDaysISO(selectedCompany.termsDays);
        hint.textContent = `${t}: due date filled in automatically. You can change it.`;
        hint.classList.remove('hidden');
    } else {
        hint.textContent = 'Tip: save payment terms on the company (Edit) and due dates fill in automatically.';
        hint.classList.remove('hidden');
    }
}

function editInvoice(companyId, index) {
    const company = companies.find(c => c.id === companyId);
    if (!company || !company.invoices || !company.invoices[index]) return;
    
    selectedCompany = company;
    editingInvoiceIndex = index;
    const inv = company.invoices[index];
    
    document.getElementById('invoice-modal').classList.add('show');
    document.getElementById('invoice-modal-title').textContent = 'Edit Invoice';
    document.getElementById('inv-number').value = inv.number;
    document.getElementById('inv-amount').value = inv.amount;
    document.getElementById('inv-due-date').value = inv.dueDate ? inv.dueDate.split('T')[0] : '';
    document.getElementById('inv-status').value = inv.status;
    document.getElementById('inv-paid-date').value = inv.paidDate ? inv.paidDate.split('T')[0] : '';
    document.getElementById('inv-payment-method').value = inv.paymentMethod || '';
    
    const isPaid = inv.status === 'Paid';
    document.getElementById('inv-paid-date').disabled = !isPaid;
    document.getElementById('inv-payment-method').disabled = !isPaid;
}

async function deleteInvoice(companyId, index) {
    if (!confirm('Delete this invoice?')) return;
    
    const company = companies.find(c => c.id === companyId);
    if (!company || !company.invoices) return;
    
    company.invoices.splice(index, 1);
    await update('companies', company);
    companies = await getAll('companies');
    selectCompany(companyId);
    showToast('Invoice deleted', 'success');
}

async function saveInvoice() {
    const num = document.getElementById('inv-number').value.trim();
    const amt = parseFloat(document.getElementById('inv-amount').value);
    const dueDate = document.getElementById('inv-due-date').value;
    const status = document.getElementById('inv-status').value;
    const paidDate = document.getElementById('inv-paid-date').value;
    const paymentMethod = document.getElementById('inv-payment-method').value;

    if (!num || isNaN(amt)) {
        showToast('Fill invoice number and amount', 'error');
        return;
    }

    const invoiceData = { 
        number: num, 
        amount: amt, 
        status,
        dueDate: dueDate ? new Date(dueDate + 'T12:00:00').toISOString() : '',
        date: new Date().toISOString()
    };
    
    if (status === 'Paid') {
        if (paidDate) {
            // FIX: Append T12:00:00 to dates
            invoiceData.paidDate = new Date(paidDate + 'T12:00:00').toISOString();
        }
        if (paymentMethod) {
            invoiceData.paymentMethod = paymentMethod;
        }
    }

    selectedCompany.invoices = selectedCompany.invoices || [];
    
    if (editingInvoiceIndex !== null) {
        // FIX: keep the invoice's original date (it was being reset to today on every edit)
        const original = selectedCompany.invoices[editingInvoiceIndex];
        if (original && original.date) invoiceData.date = original.date;
        selectedCompany.invoices[editingInvoiceIndex] = invoiceData;
        showToast('Invoice updated', 'success');
    } else {
        selectedCompany.invoices.push(invoiceData);
        showToast('Invoice added', 'success');
    }

    await update('companies', selectedCompany);
    populateCompanyYearFilters();
    companies = await getAll('companies');
    selectCompany(selectedCompany.id);
    closeModal('invoice-modal');
    renderCompanies();
}

function onInvoiceStatusChange() {
    const status = document.getElementById('inv-status').value;
    const isPaid = status === 'Paid';
    document.getElementById('inv-paid-date').disabled = !isPaid;
    document.getElementById('inv-payment-method').disabled = !isPaid;
}

async function toggleInvoiceStatus(companyId, index) {
    const company = companies.find(c => c.id === companyId);
    if (!company || !company.invoices || !company.invoices[index]) return;

    const inv = company.invoices[index];
    if (inv.status === 'Outstanding') {
        const paidDate = prompt(`Enter payment date for Invoice ${inv.number} (YYYY-MM-DD):`, new Date().toISOString().slice(0,10));
        if (!paidDate) return;
        
        const method = prompt(`Enter payment method (Check/Credit Card/ACH):`);
        
        inv.status = 'Paid';
        inv.paidDate = new Date(paidDate + 'T12:00:00').toISOString();   // FIX: was saving the day before
        if (method) inv.paymentMethod = method;
        showToast(`Invoice ${inv.number} marked as Paid`, 'success');
    } else {
        inv.status = 'Outstanding';
        delete inv.paidDate;
        delete inv.paymentMethod;
        showToast(`Invoice ${inv.number} marked as Outstanding`, 'info');
    }

    await update('companies', company);
    companies = await getAll('companies');
    selectCompany(companyId);
    renderCompanies();
}

// ==================== DISCREPANCIES ====================
function showDiscrepancyModal() {
    if (!selectedCompany) return showToast('Select a company first', 'error');
    editingDiscrepancyIndex = null;
    document.getElementById('discrepancy-modal').classList.add('show');
    document.getElementById('discrepancy-modal-title').textContent = 'Add Discrepancy';
    document.getElementById('disc-desc').value = '';
    document.getElementById('disc-date').value = new Date().toISOString().split('T')[0];
}

function editDiscrepancy(companyId, index) {
    const company = companies.find(c => c.id === companyId);
    if (!company || !company.discrepancies || !company.discrepancies[index]) return;
    
    selectedCompany = company;
    editingDiscrepancyIndex = index;
    const disc = company.discrepancies[index];
    
    document.getElementById('discrepancy-modal').classList.add('show');
    document.getElementById('discrepancy-modal-title').textContent = 'Edit Discrepancy';
    document.getElementById('disc-desc').value = disc.description;
    document.getElementById('disc-date').value = disc.date ? disc.date.split('T')[0] : '';
}

async function deleteDiscrepancy(companyId, index) {
    if (!confirm('Delete this discrepancy?')) return;
    
    const company = companies.find(c => c.id === companyId);
    if (!company || !company.discrepancies) return;
    
    company.discrepancies.splice(index, 1);
    await update('companies', company);
    companies = await getAll('companies');
    selectCompany(companyId);
    showToast('Discrepancy deleted', 'success');
}

async function saveDiscrepancy() {
    const desc = document.getElementById('disc-desc').value.trim();
    const date = document.getElementById('disc-date').value;
    
    if (!desc) {
        showToast('Enter a description', 'error');
        return;
    }

    const discData = { 
        description: desc, 
        date: date ? new Date(date + 'T12:00:00').toISOString() : new Date().toISOString()
    };
    
    selectedCompany.discrepancies = selectedCompany.discrepancies || [];
    
    if (editingDiscrepancyIndex !== null) {
        selectedCompany.discrepancies[editingDiscrepancyIndex] = discData;
        showToast('Discrepancy updated', 'success');
    } else {
        selectedCompany.discrepancies.push(discData);
        showToast('Discrepancy recorded', 'success');
    }

    await update('companies', selectedCompany);
    populateCompanyYearFilters();
    companies = await getAll('companies');
    selectCompany(selectedCompany.id);
    closeModal('discrepancy-modal');
}

// ==================== CREDIT MEMOS ====================
function showCreditModal() {
    if (!selectedCompany) return showToast('Select a company first', 'error');
    editingCreditIndex = null;
    document.getElementById('credit-modal').classList.add('show');
    document.getElementById('credit-modal-title').textContent = 'Add Credit Memo';
    document.getElementById('cred-desc').value = '';
    document.getElementById('cred-amount').value = '';
    document.getElementById('cred-date').value = new Date().toISOString().split('T')[0];
}

function editCredit(companyId, index) {
    const company = companies.find(c => c.id === companyId);
    if (!company || !company.creditMemos || !company.creditMemos[index]) return;
    
    selectedCompany = company;
    editingCreditIndex = index;
    const credit = company.creditMemos[index];
    
    document.getElementById('credit-modal').classList.add('show');
    document.getElementById('credit-modal-title').textContent = 'Edit Credit Memo';
    document.getElementById('cred-desc').value = credit.description;
    document.getElementById('cred-amount').value = credit.amount;
    document.getElementById('cred-date').value = credit.date ? credit.date.split('T')[0] : '';
}

async function deleteCredit(companyId, index) {
    if (!confirm('Delete this credit memo?')) return;
    
    const company = companies.find(c => c.id === companyId);
    if (!company || !company.creditMemos) return;
    
    company.creditMemos.splice(index, 1);
    await update('companies', company);
    companies = await getAll('companies');
    selectCompany(companyId);
    showToast('Credit memo deleted', 'success');
}

async function saveCredit() {
    const desc = document.getElementById('cred-desc').value.trim();
    const amt = parseFloat(document.getElementById('cred-amount').value);
    const date = document.getElementById('cred-date').value;
    
    if (!desc || isNaN(amt)) {
        showToast('Fill credit fields', 'error');
        return;
    }

    const creditData = { 
        description: desc, 
        amount: amt, 
        date: date ? new Date(date + 'T12:00:00').toISOString() : new Date().toISOString(),
        applied: false
    };
    
    selectedCompany.creditMemos = selectedCompany.creditMemos || [];
    
    if (editingCreditIndex !== null) {
        const existing = selectedCompany.creditMemos[editingCreditIndex];
        creditData.applied = existing.applied;
        creditData.appliedDate = existing.appliedDate;
        selectedCompany.creditMemos[editingCreditIndex] = creditData;
        showToast('Credit memo updated', 'success');
    } else {
        selectedCompany.creditMemos.push(creditData);
        showToast('Credit memo added', 'success');
    }

    await update('companies', selectedCompany);
    populateCompanyYearFilters();
    companies = await getAll('companies');
    selectCompany(selectedCompany.id);
    closeModal('credit-modal');
}

async function toggleCreditStatus(companyId, index) {
    const company = companies.find(c => c.id === companyId);
    if (!company || !company.creditMemos || !company.creditMemos[index]) return;

    const cm = company.creditMemos[index];
    if (!cm.applied) {
        const appliedDate = prompt(`Enter date applied for credit "${cm.description}" (YYYY-MM-DD):`, new Date().toISOString().slice(0,10));
        if (!appliedDate) return;
        cm.applied = true;
        cm.appliedDate = new Date(appliedDate + 'T12:00:00').toISOString();   // FIX: was saving the day before
        showToast(`Credit "${cm.description}" marked as Applied`, 'success');
    } else {
        cm.applied = false;
        delete cm.appliedDate;
        showToast(`Credit "${cm.description}" marked as Unapplied`, 'info');
    }

    await update('companies', company);
    companies = await getAll('companies');
    selectCompany(companyId);
}

// ==================== INVENTORY OPTIMIZATION ====================
function renderInventory() {
    populateSupplierFilters();    // NEW: supplier lists for Inventory and Dead Stock
    filterItems(true);
    populateReorderSuppliers();   // NEW: supplier list for Reorder tab
}

// ==================== INVENTORY RENDER (With Edit/Delete) ====================
function filterItems(immediate = false) {
    // 1. Stop pending tasks
    if (searchTimeout) clearTimeout(searchTimeout);
    if (renderChunkTimeout) clearTimeout(renderChunkTimeout);

    const runFilter = () => {
        const searchInput = document.getElementById('search');
        if (!searchInput) return; 
        
        const rawSearch = searchInput.value.toLowerCase().trim();
        const searchWords = normalizeForSearch(rawSearch).split(' ').filter(Boolean);
        const tbody = document.getElementById('inventory-body');

        // 2. Filter (Safe Version)
        // We use (val || '') to ensure we never crash on null/undefined fields
        // NEW: work out which items need reordering (same rule as the Reorder tab)
        const settings = reorderSettings();
        const onOrder = onOrderBySku();
        inventoryNeeds = new Map();
        items.forEach(it => { const info = reorderInfo(it, onOrder, settings); if (info) inventoryNeeds.set(it.id, info); });
        const onlyReorder = document.getElementById('reorder-only')?.checked;
        const countEl = document.getElementById('reorder-count');
        if (countEl) countEl.textContent = `(${inventoryNeeds.size.toLocaleString()})`;

        const supFilter = resolveSupplierFilter('inv-supplier-filter');
        const filtered = items.filter(item => {
            if (onlyReorder && !inventoryNeeds.has(item.id)) return false;
            if (supFilter.active && (item.supplier || '').trim() !== supFilter.supplier) return false;
            if (!rawSearch) return true; // Show all if search is empty

            // NEW: each word is matched on its own, in any order
            // ("5431 medieval monk" finds "HG 5431  MEDIEVAL MONK OS")
            const hay = searchTextFor(item);
            return searchWords.every(w => hay.includes(w));
        });

        sortItemsArray(filtered);

        // New search -> start again at the first 500
        const searchKey = rawSearch + (onlyReorder ? '|reorder' : '') + '|' + supFilter.supplier;
        if (searchKey !== lastInventorySearch) { inventoryLimit = INVENTORY_PAGE; lastInventorySearch = searchKey; }
        const totalMatches = filtered.length;
        const visible = filtered.slice(0, inventoryLimit);
        const footerHTML = totalMatches > visible.length
            ? `<tr class="inventory-more"><td colspan="7" style="text-align:center;padding:1rem;color:var(--text-muted);">
                 Showing ${visible.length.toLocaleString()} of ${totalMatches.toLocaleString()} items. Type in Search to narrow it down, or
                 <button class="btn-close" onclick="event.stopPropagation(); inventoryLimit += INVENTORY_PAGE; filterItems(true);">Show ${INVENTORY_PAGE} more</button>
               </td></tr>`
            : '';

        // 3. GENERATE ROW HTML (Updated with Edit/Delete buttons)
        const generateRowHTML = (item) => `
            <tr onclick="showItemModal(${item.id})">
                <td>${item.sku ? highlightMatch(item.sku, rawSearch) : '<em style="color:#ccc">N/A</em>'}</td>
                <td>${item.description ? highlightMatch(item.description, rawSearch) : '<em class="muted">No description</em>'}${reorderFlagHTML(item)}${inOrderTagHTML(item)}
                    <span class="sub">${highlightMatch(item.supplier, rawSearch)}</span>
                    <span class="sub sku-compact">${highlightMatch(item.sku, rawSearch)}</span></td>
                <td style="${inventoryNeeds.has(item.id) && (Number(item.onHand) || 0) <= 0 ? 'color:var(--danger);font-weight:600;' : ''}">${item.onHand || 0}</td>
                <td>${item.qtySold || 0}<span class="sub">$${(Number(item.sales) || 0).toFixed(2)}</span></td>
                <td>${escapeHtml(item.lastSold)}</td>
                <td>${(Number(item.cost) || 0).toFixed(2)}</td>
                <td><div class="row-actions">
                    <button class="btn-icon" onclick="event.stopPropagation(); editItem(${item.id})" title="Edit item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
                    <button class="btn-delete btn-icon" onclick="event.stopPropagation(); deleteItem(${item.id})" title="Delete item">✕</button>
                </div></td>
            </tr>
        `;

        // 4. RENDER LOGIC (Progressive)
        tbody.innerHTML = ''; // Clear previous results first
        
        const INITIAL_BATCH = 50;
        const firstBatch = visible.slice(0, INITIAL_BATCH);
        
        if (firstBatch.length > 0) {
            tbody.innerHTML = firstBatch.map(generateRowHTML).join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:1rem;">No items found</td></tr>';
            return;
        }

        if (visible.length > INITIAL_BATCH) {
            renderRemainingRows(visible, INITIAL_BATCH, generateRowHTML, footerHTML);
        } else if (footerHTML) {
            tbody.insertAdjacentHTML('beforeend', footerHTML);
        }
    };

    if (immediate) {
        runFilter();
    } else {
        searchTimeout = setTimeout(runFilter, 300);
    }
}

// Helper function to render the rest of the list without freezing the browser
function renderRemainingRows(allData, startIndex, rowGenerator, footerHTML = '') {
    const CHUNK_SIZE = 250; // Render 250 items at a time
    const tbody = document.getElementById('inventory-body');

    renderChunkTimeout = setTimeout(() => {
        // Calculate the slice for this chunk
        const nextBatch = allData.slice(startIndex, startIndex + CHUNK_SIZE);

        if (nextBatch.length > 0) {
            // Append new rows to the bottom of the table
            // insertAdjacentHTML is faster than innerHTML +=
            const html = nextBatch.map(rowGenerator).join('');
            tbody.insertAdjacentHTML('beforeend', html);

            // If there are STILL more items, schedule the next chunk
            if (startIndex + CHUNK_SIZE < allData.length) {
                renderRemainingRows(allData, startIndex + CHUNK_SIZE, rowGenerator, footerHTML);
            } else if (footerHTML) {
                tbody.insertAdjacentHTML('beforeend', footerHTML);
            }
        }
    }, 0); // 0ms delay allows the UI to breathe/update between chunks
}

function sortItems() {
    // NEW: Reorder Qty shows the biggest reorders first
    if (document.getElementById('sort').value === 'reorder' && sortOrder !== 'desc') {
        sortOrder = 'desc';
        document.getElementById('sort-btn').textContent = '↓';
    }
    filterItems();
}

function toggleSort() {
    sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
    document.getElementById('sort-btn').textContent = sortOrder === 'asc' ? '↑' : '↓';
    filterItems();
}

function sortItemsArray(arr) {
    const sortBy = document.getElementById('sort').value;
    arr.sort((a, b) => {
        let aVal = a[sortBy];
        let bVal = b[sortBy];
        
        if (sortBy === 'reorder') {   // NEW: biggest reorder first when sorted descending
            aVal = inventoryNeeds.get(a.id)?.qty || 0;
            bVal = inventoryNeeds.get(b.id)?.qty || 0;
        } else
        // Handle numeric fields
        if (['onHand', 'qtySold', 'sales', 'cost'].includes(sortBy)) {
            aVal = parseFloat(aVal) || 0;
            bVal = parseFloat(bVal) || 0;
        } else {
            aVal = aVal || '';
            bVal = bVal || '';
        }
        
        if (aVal === bVal) return 0;
        const cmp = aVal > bVal ? 1 : -1;
        return sortOrder === 'asc' ? cmp : -cmp;
    });
}

// Find the line in the current order that is the same product
// (same inventory item, or same SKU, or same supplier + description when there is no SKU)
function findOrderLine(item) {
    if (!item) return -1;
    const key = inventoryKey(item);
    return currentOrder.items.findIndex(l => l.id === item.id || inventoryKey(l) === key);
}

function showItemModal(itemId) {
    selectedItem = items.find(i => i.id === itemId);
    if (!selectedItem) return;
    const lineIndex = findOrderLine(selectedItem);
    const inOrder = lineIndex >= 0 ? currentOrder.items[lineIndex].qty : 0;
    const info = inventoryNeeds.get(selectedItem.id);
    // Suggestion minus what is already in this (unsaved) order, in full packs
    const stillNeeded = info ? roundToPack(Math.max(0, info.need - inOrder), info.pack) : 0;

    document.getElementById('item-modal').classList.add('show');
    document.getElementById('item-info').innerHTML = `
        ${inOrder ? `<div class="dup-warning"><strong>Already in this order: ${inOrder}</strong>
            <span>Choose below whether to add more or change the quantity.</span></div>` : ''}
        <strong>${escapeHtml(selectedItem.description)}</strong><br>
        SKU: ${escapeHtml(selectedItem.sku)}<br>
        Cost: ${(Number(selectedItem.cost) || 0).toFixed(2)}<br>
        On Hand: ${selectedItem.onHand}
        ${info ? `<div class="reorder-hint">Suggested reorder: <strong>${info.qty}</strong>${inOrder ? ` · <strong>${stillNeeded}</strong> still needed` : ''}<br>
            <span>Sold ${info.sold} this year · ${info.onHand} on hand${info.coming ? ` · ${info.coming} already on order` : ''}${info.pack > 1 ? ` · needs ${info.need}, rounded to packs of ${info.pack}` : ''}</span></div>` : ''}
        <label class="pack-row">Case pack
            <input type="number" min="1" id="item-pack" value="${packOf(selectedItem) > 1 ? packOf(selectedItem) : ''}" placeholder="1"
                   onchange="saveCasePack(${selectedItem.id}, this.value)">
            <span>Saved for this item; suggestions round up to full packs.</span>
        </label>
    `;
    const qtyInput = document.getElementById('item-qty');
    qtyInput.value = inOrder ? (stillNeeded || 1) : (info?.qty || 1);
    updateItemModalButtons();
    setTimeout(() => { qtyInput.focus(); qtyInput.select(); }, 50);
}

// Button labels follow the quantity typed: "Add 2 more (total 5)" / "Change to 2"
function updateItemModalButtons() {
    const qty = parseInt(document.getElementById('item-qty').value) || 0;
    const lineIndex = findOrderLine(selectedItem);
    const addBtn = document.getElementById('item-add-btn');
    const setBtn = document.getElementById('item-set-btn');
    // NEW: warn when the total isn't a full case pack
    const hintEl = document.getElementById('item-pack-hint');
    if (hintEl && selectedItem) {
        const total = lineIndex >= 0 ? currentOrder.items[lineIndex].qty + qty : qty;
        const h = packHintHTML(selectedItem, lineIndex >= 0 ? total : qty);
        hintEl.innerHTML = h;
        hintEl.classList.toggle('hidden', !h);
    }
    if (lineIndex >= 0) {
        const cur = currentOrder.items[lineIndex].qty;
        addBtn.textContent = `Add ${qty} more (total ${cur + qty})`;
        setBtn.textContent = `Change to ${qty}`;
        setBtn.classList.remove('hidden');
    } else {
        addBtn.textContent = 'Add';
        setBtn.classList.add('hidden');
    }
}

function addItemToOrder(mode = 'add') {
    const qty = parseInt(document.getElementById('item-qty').value) || 0;
    if (!selectedItem || qty <= 0) {
        showToast('Invalid quantity', 'error');
        return;
    }

    const existingIndex = findOrderLine(selectedItem);

    if (existingIndex >= 0) {
        // Already in the order: the window already warned, so no extra pop-up here
        const line = currentOrder.items[existingIndex];
        const before = line.qty;
        line.qty = mode === 'set' ? qty : line.qty + qty;
        line.lineTotal = line.cost * line.qty;
        updateOrderRowInDOM(existingIndex);
        updateOrderTotals();
        refreshInOrderTags();
        closeModal('item-modal');
        showToast(mode === 'set'
            ? `Quantity changed from ${before} to ${line.qty}`
            : `Added ${qty} more. Now ${line.qty} in the order`, 'success');
        return;
    }

    currentOrder.items.push({
        id: selectedItem.id,
        sku: selectedItem.sku,
        supplier: selectedItem.supplier,
        description: selectedItem.description,
        onHand: selectedItem.onHand,
        qtySold: selectedItem.qtySold,
        sales: selectedItem.sales,
        lastSold: selectedItem.lastSold,
        cost: selectedItem.cost,
        qty,
        lineTotal: selectedItem.cost * qty
    });
    renderOrderItems();
    updateOrderTotals();
    closeModal('item-modal');
    showToast('Item added', 'success');
}

// Blue "In order: N" tag in the Inventory list, so you can see what's already added
function inOrderTagHTML(item) {
    const i = findOrderLine(item);
    return `<span class="in-order-tag" data-in-order="${item.id}">${i >= 0 ? `In order: ${currentOrder.items[i].qty}` : ''}</span>`;
}
function refreshInOrderTags() {
    document.querySelectorAll('#inventory-body .in-order-tag').forEach(el => {
        const it = items.find(x => x.id === +el.dataset.inOrder);
        const i = findOrderLine(it);
        el.textContent = i >= 0 ? `In order: ${currentOrder.items[i].qty}` : '';
    });
}

// ==================== INVENTORY ACTIONS ====================

// Open Modal to Create New Item
function showCustomItemModal() {
    editingItemId = null; // Reset editing ID
    document.getElementById('custom-modal').classList.add('show');
    document.querySelector('#custom-modal h2').textContent = "Add Custom Item"; // Update Title
    
    // Clear fields
    document.getElementById('ci-sku').value = '';
    document.getElementById('ci-supplier').value = '';
    document.getElementById('ci-desc').value = '';
    document.getElementById('ci-onhand').value = '0';
    document.getElementById('ci-cost').value = '';
    document.getElementById('ci-date').value = '';
}

// Open Modal to Edit Existing Item
function editItem(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;

    editingItemId = id; // Set global editing ID
    document.getElementById('custom-modal').classList.add('show');
    document.querySelector('#custom-modal h2').textContent = "Edit Item"; // Update Title

    // Populate fields
    document.getElementById('ci-sku').value = item.sku;
    document.getElementById('ci-supplier').value = item.supplier;
    document.getElementById('ci-desc').value = item.description;
    document.getElementById('ci-onhand').value = item.onHand;
    document.getElementById('ci-cost').value = item.cost;
    
    // Handle date formatting
    if (item.lastSold) {
        // Ensure date is in YYYY-MM-DD format for the input
        const dateStr = item.lastSold.includes('T') ? item.lastSold.split('T')[0] : item.lastSold;
        document.getElementById('ci-date').value = dateStr;
    } else {
        document.getElementById('ci-date').value = '';
    }
}

// Delete Item
async function deleteItem(id) {
    if (!confirm('Are you sure you want to delete this item permanently?')) return;

    try {
        await deleteRecord('items', id);
        
        // 1. Refresh the global data from the database
        items = await getAll('items'); 
        
        // 2. Force the table to re-render immediately (skipping the delay)
        filterItems(true); 
        
        showToast('Item deleted successfully', 'success');
    } catch (error) {
        console.error(error);
        showToast('Failed to delete item', 'error');
    }
}

async function saveCustomItem() {
    const sku = document.getElementById('ci-sku').value.trim();
    const supplier = document.getElementById('ci-supplier').value.trim();
    const description = document.getElementById('ci-desc').value.trim();
    const cost = parseFloat(document.getElementById('ci-cost').value) || 0;
    
    if (!sku || !supplier || !description) {
        showToast('Fill all required fields (SKU, Supplier, Desc)', 'error');
        return;
    }
    
    const itemData = {
        sku,
        supplier,
        description,
        onHand: parseInt(document.getElementById('ci-onhand').value) || 0,
        lastSold: normalizeDate(document.getElementById('ci-date').value),
        cost
    };
    
    try {
        if (editingItemId) {
            // UPDATE EXISTING
            const existingItem = items.find(i => i.id === editingItemId);
            
            // Merge new data with existing data (preserving sales history)
            const updatedItem = {
                ...existingItem,
                ...itemData
            };
            
            await update('items', updatedItem);
            showToast('Item updated successfully', 'success');
        } else {
            // CREATE NEW
            // Initialize sales fields for new items
            itemData.qtySold = 0;
            itemData.sales = 0;
            itemData.custom = true;   // so a later items.csv upload doesn't remove it
            
            await add('items', itemData);
            showToast('New item added successfully', 'success');
        }
        
        items = await getAll('items'); // Refresh global data
        renderInventory(); // Refresh table
        closeModal('custom-modal');
        
    } catch (error) {
        console.error(error);
        showToast('Failed to save item', 'error');
    }
}

// ==================== RESET / CLEAR INVENTORY ====================
async function clearInventory() {
    if (!confirm('WARNING: This will delete ALL items from the inventory database.\n\nYour Sales history and Orders will remain, but all Item details will be wiped.\n\nYou must re-upload your items.csv immediately after this.\n\nAre you sure?')) {
        return;
    }

    try {
        const transaction = db.transaction(['items'], 'readwrite');
        const store = transaction.objectStore('items');
        const request = store.clear(); // Wipes the object store

        request.onsuccess = async () => {
            items = []; // Clear global array
            renderInventory(); // Update UI to show empty table
            showToast('Inventory database wiped. Please re-upload items.csv.', 'success');
        };

        request.onerror = (e) => {
            console.error(e);
            showToast('Failed to clear inventory', 'error');
        };
    } catch (error) {
        console.error(error);
        showToast('Error clearing DB: ' + error.message, 'error');
    }
}

// ==================== ORDER BUILDER ====================
function updateOrderRowInDOM(index) {
    const tbody = document.getElementById('order-body');
    const row = tbody.rows[index];
    if (!row) return;

    const item = currentOrder.items[index];

    // 1. Update Inputs (Safety check to ensure we update the right fields)
    const inputs = row.querySelectorAll('input');
    if (inputs[0]) inputs[0].value = item.qty;         // Qty Input
    if (inputs[1]) inputs[1].value = item.cost.toFixed(2); // Cost Input

    // 2. Update Line Total Cell (Column index 4)
    // Structure: 0=SKU, 1=Desc, 2=Qty, 3=Cost, 4=Total, 5=Delete
    if (row.cells[4]) {
        row.cells[4].textContent = item.lineTotal.toFixed(2);
    }
}

function renderOrderItems() {
    const tbody = document.getElementById('order-body');
    tbody.innerHTML = currentOrder.items.map((item, index) => `
        <tr>
            <td>${escapeHtml(item.sku)}</td>
            <td>${escapeHtml(item.description)}${(() => {
                const pack = packOf(inventoryItemFor(item));
                if (pack <= 1) return '';
                return item.qty % pack === 0
                    ? `<div class="sub">${item.qty / pack} pack${item.qty / pack === 1 ? '' : 's'} of ${pack}</div>`
                    : `<div class="sub pack-warn">Not a full pack of ${pack}</div>`;
            })()}</td>
            <td><input type="number" value="${item.qty}" min="0" onchange="updateItemQty(${index}, this.value)"></td>
            <td><input type="number" value="${item.cost.toFixed(2)}" step="0.01" onchange="updateItemPrice(${index}, this.value)"></td>
            <td>${item.lineTotal.toFixed(2)}</td>
            <td>
                <button onclick="removeOrderItem(${index})" class="btn-delete btn-icon" title="Remove from order">✕</button>
            </td>
        </tr>
    `).join('');

    document.getElementById('save-btn').disabled = !selectedCompany || currentOrder.items.length === 0;
}

function updateItemPrice(index, newPrice) {
    const price = parseFloat(newPrice);
    if (isNaN(price) || price < 0) {
        showToast('Invalid price', 'error');
        return;
    }
    
    // Update Data
    currentOrder.items[index].cost = price;
    currentOrder.items[index].lineTotal = price * currentOrder.items[index].qty;

    // OPTIMIZATION: Update only this row
    updateOrderRowInDOM(index);
    updateOrderTotals();
}

function updateItemQty(index, newQty) {
    const qty = parseInt(newQty) || 0;
    if (qty <= 0) {
        removeOrderItem(index); // If 0, remove it (this still requires full re-render)
        return;
    }
    
    // Update Data
    currentOrder.items[index].qty = qty;
    currentOrder.items[index].lineTotal = currentOrder.items[index].cost * qty;

    // OPTIMIZATION: Update only this row
    updateOrderRowInDOM(index);
    updateOrderTotals();
}

function removeOrderItem(index) {
    currentOrder.items.splice(index, 1);
    updateOrderTotals();
    renderOrderItems();
    showToast('Item removed', 'info');
}

function updateOrderTotals() {
    currentOrder.subtotal = currentOrder.items.reduce((sum, item) => sum + item.lineTotal, 0);
    currentOrder.total = currentOrder.subtotal;
    
    document.getElementById('subtotal').textContent = `${currentOrder.subtotal.toFixed(2)}`;
    document.getElementById('total').textContent = `${currentOrder.total.toFixed(2)}`;
    renderOrderThresholds();   // NEW: minimum order / free shipping
}

// closeAfter = false: the order stays open in the Order Builder (later saves update it)
// closeAfter = true:  "Save & Close" — saves, then clears the builder for a new order
async function saveOrder(closeAfter = false) {
    if (!selectedCompany || currentOrder.items.length === 0) {
        showToast('Select company and add items', 'error');
        return;
    }
    
    // GET DATE FROM INPUT
    const dateInput = document.getElementById('order-date').value;
    // Use input date if exists, otherwise current time
    const orderDate = dateInput 
        ? new Date(dateInput + 'T12:00:00').toISOString() 
        : new Date().toISOString();
    
    const orderData = {
        companyId: selectedCompany.id,
        companyName: selectedCompany.name,
        date: orderDate,
        items: currentOrder.items,
        subtotal: currentOrder.subtotal,
        total: currentOrder.total,
        notes: '',
        // NEW: PO number (filled in automatically if left blank)
        poNumber: document.getElementById('order-po').value.trim() || nextPONumber(orderDate)
    };
    
    try {
        if (editingOrderId) {
            orderData.id = editingOrderId;
            // NEW: keep the order's status and what was already received
            const old = orders.find(o => o.id === editingOrderId);
            if (old) {
                const recv = new Map((old.items || []).map(i => [inventoryKey(i), i.received || 0]));
                orderData.items = orderData.items.map(i => ({ ...i, received: recv.get(inventoryKey(i)) || 0 }));
                const anyIn = orderData.items.some(i => i.received > 0);
                const allIn = orderData.items.every(i => i.received >= i.qty);
                orderData.status = allIn && anyIn ? 'Received' : anyIn ? 'Partly received' : 'Placed';
                if (old.receivedDate) orderData.receivedDate = old.receivedDate;
            }
            await update('orders', orderData);
        } else {
            orderData.status = 'Placed';
            orderData.id = await add('orders', orderData);
        }
        
        orders = await getAll('orders');
        if (closeAfter) {
            clearOrder(false);
            showToast(`${orderData.poNumber} saved and closed`, 'success');
        } else {
            // NEW: stay on the order. From now on Save updates this same order.
            editingOrderId = orderData.id;
            currentOrder.items = orderData.items.map(i => ({ ...i }));
            document.getElementById('order-po').value = orderData.poNumber;
            clearOrderDraft();                                   // it's saved, no draft needed
            lastDraftSignature = JSON.stringify(currentDraft());
            lastSavedSignature = orderSignatureForSave();
            renderOrderItems();
            updateOrderTotals();
            showToast(`${orderData.poNumber} saved`, 'success');
        }
        updateBuilderStatus();
        filterItems(true);       // NEW: reorder flags now count this order as "on order"
        populateYearFilters();   // FIX: a new year now appears in the Ledger dropdown
        renderOrdersLedger();
        renderCompanies();
        updateStats();
        
        if (selectedCompany) {
            // Force year refresh to ensure new year appears in dropdown
            populateCompanyYearFilters();
            renderCompanySections();
        }
    } catch (error) {
        console.error(error);
        showToast('Failed to save order', 'error');
    }
}

function clearOrder(showMessage = true) {
    currentOrder = { items: [], subtotal: 0, total: 0 };
    clearOrderDraft();   // NEW: the order was saved or cleared, so the draft isn't needed
    editingOrderId = null;
    
 // Reset Date to Today
    document.getElementById('order-date').valueAsDate = new Date();
    document.getElementById('order-po').value = '';
    
    renderOrderItems();
    updateOrderTotals();
    // FIX: "Order cleared" was covering up the "Order saved" message
    if (showMessage) showToast('Order cleared', 'info');
}

function loadOrder(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;
    
    currentOrder = {
        items: order.items.map(i => ({ ...i })),   // FIX: copy, so editing doesn't change the saved order until you save
        subtotal: order.subtotal,
        total: order.total
    };
    editingOrderId = orderId;

    // FIX: switch to the order's company, otherwise saving moved the order to whatever company was selected
    if (!selectedCompany || selectedCompany.id !== order.companyId) {
        selectCompany(order.companyId);
    }
    
    // Set Date Input
    const dateStr = order.date.split('T')[0];
    document.getElementById('order-date').value = dateStr;
    document.getElementById('order-po').value = order.poNumber || '';

    renderOrderItems();
    updateOrderTotals();
    switchTab('builder');
    showToast('Order loaded for editing', 'info');
}

// ==================== ORDERS LEDGER ====================
function populateYearFilters() {
    const years = new Set();
    const currentYear = new Date().getFullYear();
    
    // 1. Get years from Internal Orders
    orders.forEach(o => {
        if (o.date) years.add(new Date(o.date).getFullYear());
    });

    // 2. Get years from External Orders (Check ALL companies)
    companies.forEach(c => {
        if (c.externalOrders) {
            c.externalOrders.forEach(eo => {
                if (eo.date) years.add(new Date(eo.date).getFullYear());
            });
        }
    });
    
    // ALWAYS include current year and next year to allow creating new orders
    years.add(currentYear);
    years.add(currentYear + 1);
    
    const sortedYears = Array.from(years).sort((a, b) => b - a);
    const select = document.getElementById('ledger-year-filter');
    
    // Save current selection if it exists to prevent resetting on refresh
    const currentSelection = select ? select.value : null;

    if (select) {
        select.innerHTML = sortedYears.map(y => 
            `<option value="${y}">${y}</option>`
        ).join('');

        // Restore selection if it's still valid, otherwise select the first (newest) year
        if (currentSelection && sortedYears.includes(parseInt(currentSelection))) {
            select.value = currentSelection;
        } else {
            select.value = currentYear;   // FIX: opened on next year, so the Ledger looked empty
        }
    }
}

function renderOrdersLedger() {
    const list = document.getElementById('orders-list');
    const totalDisplay = document.getElementById('ledger-total-amount');
    
    // Get year from the dropdown. If missing, default to current year or top of list.
    const select = document.getElementById('ledger-year-filter');
    let yearFilter = select && select.value ? parseInt(select.value) : new Date().getFullYear();

    // --- 1. GATHER INTERNAL ORDERS ---
    const internalOrders = orders
        .filter(o => new Date(o.date).getFullYear() === yearFilter)
        .map(o => ({
            ...o,
            type: 'Internal',
            sortDate: new Date(o.date)
        }));

    // --- 2. GATHER EXTERNAL ORDERS (FROM ALL COMPANIES) ---
    const externalOrders = [];
    companies.forEach(c => {
        if (c.externalOrders) {
            c.externalOrders.forEach((eo, index) => {
                if (eo.date && new Date(eo.date).getFullYear() === yearFilter) {
                    externalOrders.push({
                        id: `ext-${c.id}-${index}`, // Fake ID for list key
                        companyId: c.id,
                        companyName: c.name,
                        date: eo.date,
                        total: eo.amount,
                        items: [], // External orders don't have items
                        type: 'External',
                        po: eo.poNumber,
                        originalIndex: index,
                        sortDate: new Date(eo.date)
                    });
                }
            });
        }
    });

    // --- 3. COMBINE & CALCULATE TOTAL ---
    const allOrders = [...internalOrders, ...externalOrders];
    allOrders.sort((a, b) => b.sortDate - a.sortDate); // Newest first

    // Sum up EVERYTHING (Internal + External) for the selected year
    const grandTotal = allOrders.reduce((sum, order) => sum + order.total, 0);
    
    // Update the Header Display
    if (totalDisplay) {
        totalDisplay.textContent = `$${grandTotal.toFixed(2)}`;
    }

    // --- 4. RENDER LIST ---
    // NEW: status filter (external orders have no status, shown under "All" only)
    const statusFilter = document.getElementById('ledger-status-filter')?.value || 'all';
    if (statusFilter !== 'all') {
        for (let i = allOrders.length - 1; i >= 0; i--) {
            const o = allOrders[i];
            const keep = o.type === 'Internal' &&
                (statusFilter === 'open' ? orderStatus(o) !== 'Received' : orderStatus(o) === 'Received');
            if (!keep) allOrders.splice(i, 1);
        }
    }
    if (allOrders.length === 0) {
        list.innerHTML = '<div class="empty" style="text-align:center;padding:2rem;">No orders for this year</div>';
        return;
    }
    
    list.innerHTML = allOrders.map(order => {
        const isExternal = order.type === 'External';
        const subLabel = isExternal 
            ? `External Order - PO: ${order.po}` 
            : `${order.items.length} item(s)`;
        
        // Correct functions for Edit/Delete based on type
        const editAction = isExternal
            ? `editExternalOrder(${order.companyId}, ${order.originalIndex})`
            : `loadOrder(${order.id})`;

        const deleteAction = isExternal
            ? `deleteExternalOrder(${order.companyId}, ${order.originalIndex})`
            : `deleteOrder(${order.id})`;

        const exportBtn = isExternal 
            ? '' 
            : `<button onclick="exportOrder(${order.id})">Excel</button>
               <button onclick="printSavedPO(${order.id})">Print PO</button>
               <button onclick="emailSavedPO(${order.id})">Email</button>`;

        return `
        <div class="${isExternal ? 'external-order-row' : ''}">
            <div class="order-header">
                <div class="order-company">
                    ${order.companyName} 
                    <span class="pill" style="background:${isExternal ? '#e2e8f0' : '#dbeafe'};color:${isExternal ? '#475569' : '#1e40af'};">${order.type}</span>
                    ${isExternal ? '' : statusBadge(order)}
                </div>
                <div class="order-total">$${order.total.toFixed(2)}</div>
            </div>
            <div class="order-date">${new Date(order.date).toLocaleDateString()}${!isExternal && order.poNumber ? ` · ${escapeHtml(order.poNumber)}` : ''}</div>
            <div class="order-date" style="margin-bottom:0.55rem;">${subLabel}</div>
            <div class="order-actions">
                <button class="btn-edit" onclick="${editAction}">Edit</button>
                ${isExternal ? '' : `<button class="btn-receive" onclick="showReceiveModal(${order.id})">Receive</button>`}
                ${exportBtn}
                <button class="btn-delete" onclick="${deleteAction}">Delete</button>
            </div>
        </div>
    `}).join('');
}

async function deleteOrder(orderId) {
    if (!confirm('Delete this order?')) return;
    
    try {
        await deleteRecord('orders', orderId);
        orders = await getAll('orders');
        if (editingOrderId === orderId) clearOrder(false);
        renderOrdersLedger();
        renderCompanies();
        if (selectedCompany) renderCompanySections();
        updateStats();
        showToast('Order deleted', 'success');
    } catch (error) {
        showToast('Failed to delete order', 'error');
    }
}

function exportOrder(orderId) {
    const order = orders.find(o => o.id === orderId);
    const company = companies.find(c => c.id === order.companyId);
    if (!order || !company) return;

    const wsData = [
        ['Order for', company.name],
        ['Date', new Date(order.date).toLocaleDateString()],
        ['Customer #', company.customerNumber],
        [],
        ['SKU', 'Supplier', 'Description', 'Qty', 'Cost', 'Line Total'],
        ...order.items.map(item => [
            item.sku, item.supplier, item.description, item.qty,
            item.cost, item.lineTotal
        ]),
        [],
        ['', '', '', '', 'Subtotal', order.subtotal],
        ['', '', '', '', 'Total', order.total]
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Order');

    const filename = `Order_${company.name}_${new Date(order.date).toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, filename);

    showToast('Order exported to Excel', 'success');
}

// ==================== STATS ====================
function updateStats() {
    document.getElementById('stat-companies').textContent = companies.length;
    
    // Arrays to hold ALL orders (Internal and External) for the selected year
    let yearlyOrderRecords = [];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const currentYear = selectedYear || new Date().getFullYear();

    // 1. Process Internal Orders (Orders made within the program)
    orders.forEach(order => {
        if (new Date(order.date).getFullYear() === currentYear) {
            yearlyOrderRecords.push({
                date: new Date(order.date),
                amount: order.total,
                companyName: order.companyName,
                isExternal: false
            });
        }
    });

    // 2. Process External Orders (Orders made outside the program)
    companies.forEach(company => {
        if (company.externalOrders) {
            company.externalOrders.forEach(extOrder => {
                // Ensure the order has valid data and matches the selected year
                if (extOrder.date && extOrder.amount && new Date(extOrder.date).getFullYear() === currentYear) {
                    yearlyOrderRecords.push({
                        date: new Date(extOrder.date),
                        amount: extOrder.amount,
                        companyName: company.name,
                        isExternal: true,
                        poNumber: extOrder.poNumber // Keep PO for display
                    });
                }
            });
        }
    });
    
    // 3. Update Total Order Count for the Year (Uses your existing 'stat-orders' ID)
    // NOTE: This now reports the total orders for the selected year, not just the last 30 days.
    document.getElementById('stat-orders').textContent = yearlyOrderRecords.length; 

    // 4. Filter and Sort for Recent Orders (last 30 days)
    const recentOrders = yearlyOrderRecords
        .filter(r => r.date >= thirtyDaysAgo)
        .sort((a, b) => b.date - a.date); // Sort by most recent first
    
    // 5. Update Recent Orders List in the Ledger (Requires the 'recent-orders-list' ID from previous steps)
    const recentOrdersList = document.getElementById('recent-orders-list');
    if (recentOrdersList) {
        recentOrdersList.innerHTML = recentOrders.slice(0, 5).map(order => `
            <div class="recent-order-item ${order.isExternal ? 'external-order' : ''}">
                <span>${order.companyName} (${order.isExternal ? 'Ext' : 'Int'}${order.isExternal ? ' - ' + order.poNumber : ''})</span>
                <span style="font-weight:600;">$${order.amount.toFixed(2)}</span>
            </div>
        `).join('');
    }
    
    // 6. Top suppliers (Retains your original logic, using only internal orders as external orders don't have item details)
    const supplierSales = {};
    orders.forEach(order => { 
        order.items.forEach(item => {
            supplierSales[item.supplier] = (supplierSales[item.supplier] || 0) + item.lineTotal;
        });
    });
    
    const topSuppliers = Object.entries(supplierSales)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    
    document.getElementById('top-suppliers').innerHTML = topSuppliers.length > 0
        ? '<div class="supplier-title">Top suppliers (all orders)</div>' +
          topSuppliers.map(([supplier, total]) => `
            <div class="supplier-item">
                <span>${escapeHtml(supplier || 'No supplier')}</span>
                <span>$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
          `).join('')
        : '';
}

// ==================== TABS ====================
function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    
    if (tab === 'builder') {
        document.getElementById('tab-builder').classList.add('active');
        document.getElementById('builder-content').classList.remove('hidden');
    } else if (tab === 'dead') {
        document.getElementById('tab-dead').classList.add('active');
        document.getElementById('dead-content').classList.remove('hidden');
        renderDeadStock();
    } else if (tab === 'reorder') {
        document.getElementById('tab-reorder').classList.add('active');
        document.getElementById('reorder-content').classList.remove('hidden');
        renderReorder();
    } else {
        document.getElementById('tab-ledger').classList.add('active');
        document.getElementById('ledger-content').classList.remove('hidden');
    }
}

// ==================== MODALS ====================
function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('show');
}

// Close modal when clicking outside
window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('show');
    }
});

// ==================== KEYBOARD SHORTCUTS ====================
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (currentOrder.items.length > 0 && selectedCompany) {
            saveOrder(e.shiftKey);   // Ctrl+Shift+S = Save & Close
        }
    }
});
// ==================== BACKUP: EXPORT / IMPORT (move data between computers) ====================
// Orders live in this browser's IndexedDB, so another computer can't see them.
// Export writes companies (with invoices, external orders, credits, discrepancies),
// orders and custom items to one .json file. Import reads that file on the other computer.
// Inventory is NOT included: it comes from items.csv / 2026.csv on each computer.

const BACKUP_APP = 'LaCasaOrderingSystem';
let pendingBackup = null;

async function exportBackup() {
    try {
        const data = {
            app: BACKUP_APP,
            version: 1,
            exportedAt: new Date().toISOString(),
            companies: await getAll('companies'),
            orders: await getAll('orders'),
            customItems: (await getAll('items')).filter(i => i.custom),
            // NEW: case packs and store info travel with the backup
            casePacks: (await getAll('items')).filter(i => i.casePack > 1)
                .map(i => ({ sku: i.sku, supplier: i.supplier, description: i.description, casePack: i.casePack })),
            storeInfo: getStoreInfo(),
            settings: getSettings()
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const d = new Date();
        const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        a.href = url;
        a.download = `ordering-backup-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast(`Backup saved: ${data.companies.length} companies, ${data.orders.length} orders`, 'success');
    } catch (error) {
        console.error('Export error:', error);
        showToast('Backup failed: ' + error.message, 'error');
    }
}

async function handleBackupFile(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
        openBackupData(JSON.parse(await file.text()), file.name);
    } catch (error) {
        console.error('Import read error:', error);
        showToast('Could not read the backup file', 'error');
    }
}

// Shows the Merge / Replace window for backup data (from a file or from the website)
function openBackupData(data, name) {
        if (data.app !== BACKUP_APP || !Array.isArray(data.companies) || !Array.isArray(data.orders)) {
            showToast('This is not a backup file from this program', 'error');
            return;
        }
        pendingBackup = data;
        const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'unknown date';
        closeModal('settings-modal');
        document.getElementById('backup-info').innerHTML = `
            <strong>${escapeHtml(name)}</strong><br>
            Made: ${escapeHtml(when)}<br>
            ${data.companies.length} companies, ${data.orders.length} orders,
            ${(data.customItems || []).length} custom items<br><br>
            This device now has ${companies.length} companies and ${orders.length} orders.`;
        document.getElementById('backup-modal').classList.add('show');
}

// For the r1 (no file picker): read backup.json from the same folder as the page
async function loadBackupFromSite() {
    try {
        const res = await fetch('backup.json?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) { showToast('No backup.json found next to this page', 'error'); return; }
        openBackupData(await res.json(), 'backup.json (website)');
    } catch (e) {
        console.error(e);
        showToast('Could not load backup.json from the website', 'error');
    }
}

const normKey = v => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
const dayOf = v => (v ? String(v).slice(0, 10) : '');

function companyKey(c) {
    return c.customerNumber ? 'num:' + normKey(c.customerNumber) : 'name:' + normKey(c.name);
}

function orderSignature(o, cKey) {
    const lines = (o.items || []).map(i => `${normKey(i.sku || i.description)}x${i.qty}`).sort().join(',');
    return `${cKey}|${dayOf(o.date)}|${(Number(o.total) || 0).toFixed(2)}|${lines}`;
}

// Merge a list inside a company (invoices, credits, ...) without making duplicates
function mergeList(existing = [], incoming = [], keyFn, preferIncoming) {
    const out = existing.map(x => ({ ...x }));
    incoming.forEach(inc => {
        const i = out.findIndex(x => keyFn(x) === keyFn(inc));
        if (i === -1) out.push({ ...inc });
        else if (preferIncoming && preferIncoming(out[i], inc)) out[i] = { ...inc };
    });
    return out;
}

async function importBackup(mode) {
    const data = pendingBackup;
    if (!data) return;
    closeModal('backup-modal');

    if (mode === 'replace' && !confirm(
        'REPLACE will delete all companies and orders on THIS computer and put the backup in their place.\n\n' +
        'Tip: click "Export Backup" first if you want to keep a copy of this computer\'s data.\n\nContinue?')) {
        return;
    }

    try {
        let addedCompanies = 0, addedOrders = 0, skippedOrders = 0, addedItems = 0;

        if (mode === 'replace') {
            await clearStore('companies');
            await clearStore('orders');
            // Keep the original ids so every order stays linked to its company
            await saveBatch('companies', data.companies);
            await saveBatch('orders', data.orders);
            addedCompanies = data.companies.length;
            addedOrders = data.orders.length;
        } else {
            // MERGE: match companies by Customer Number (or name), add only what is missing
            const current = await getAll('companies');
            const byKey = new Map(current.map(c => [companyKey(c), c]));
            const idMap = new Map();   // backup company id -> id on this computer

            for (const inc of data.companies) {
                const match = byKey.get(companyKey(inc));
                if (match) {
                    ['address', 'rep', 'phone', 'email', 'notes'].forEach(f => {
                        if (!match[f] && inc[f]) match[f] = inc[f];
                    });
                    match.invoices = mergeList(match.invoices, inc.invoices,
                        x => normKey(x.number),
                        (old, nw) => old.status !== 'Paid' && nw.status === 'Paid');
                    match.externalOrders = mergeList(match.externalOrders, inc.externalOrders,
                        x => normKey(x.poNumber) + '|' + dayOf(x.date));
                    match.creditMemos = mergeList(match.creditMemos, inc.creditMemos,
                        x => normKey(x.description) + '|' + (Number(x.amount) || 0).toFixed(2),
                        (old, nw) => !old.applied && nw.applied);
                    match.discrepancies = mergeList(match.discrepancies, inc.discrepancies,
                        x => normKey(x.description) + '|' + dayOf(x.date));
                    await update('companies', match);
                    idMap.set(inc.id, match.id);
                } else {
                    const copy = { ...inc };
                    delete copy.id;
                    const newId = await add('companies', copy);
                    copy.id = newId;
                    byKey.set(companyKey(copy), copy);
                    idMap.set(inc.id, newId);
                    addedCompanies++;
                }
            }

            const allCompanies = await getAll('companies');
            const keyById = new Map(allCompanies.map(c => [c.id, companyKey(c)]));
            const existingOrders = await getAll('orders');
            const seen = new Set(existingOrders.map(o => orderSignature(o, keyById.get(o.companyId))));

            for (const inc of data.orders) {
                const newCompanyId = idMap.get(inc.companyId);
                if (newCompanyId == null) { skippedOrders++; continue; }   // its company wasn't in the backup
                const sig = orderSignature(inc, keyById.get(newCompanyId));
                if (seen.has(sig)) { skippedOrders++; continue; }          // already on this computer
                const copy = { ...inc, companyId: newCompanyId };
                delete copy.id;
                await add('orders', copy);
                seen.add(sig);
                addedOrders++;
            }
        }

        // Custom items: add any that this computer doesn't have yet
        const currentItems = await getAll('items');
        const itemKeys = new Set(currentItems.map(inventoryKey));
        const newItems = (data.customItems || [])
            .filter(it => !itemKeys.has(inventoryKey(it)))
            .map(it => { const c = { ...it, custom: true }; delete c.id; return c; });
        if (newItems.length) await saveBatch('items', newItems);
        addedItems = newItems.length;

        // NEW: case packs (merge keeps this computer's own packs) and store info
        if (Array.isArray(data.casePacks) && data.casePacks.length) {
            const all = await getAll('items');
            const byKey = new Map(all.map(i => [inventoryKey(i), i]));
            const changed = [];
            data.casePacks.forEach(cp => {
                const it = byKey.get(inventoryKey(cp));
                if (it && (mode === 'replace' || !(it.casePack > 1)) && it.casePack !== cp.casePack) {
                    it.casePack = cp.casePack; changed.push(it);
                }
            });
            if (changed.length) await saveBatch('items', changed);
        }
        if (data.settings && mode === 'replace') { setSettings(data.settings); startAutosave(); }
        if (data.storeInfo && (mode === 'replace' || !(() => { try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } })())) setStoreInfo(data.storeInfo);

        companies = await getAll('companies');
        orders = await getAll('orders');
        items = await getAll('items');
        selectedCompany = null;
        clearOrder(false);
        if (typeof clearCompanySelection === 'function') clearCompanySelection();
        renderCompanies();
        renderInventory();
        populateYearFilters();
        renderOrdersLedger();
        updateStats();

        const skipped = skippedOrders ? `, ${skippedOrders} already here (skipped)` : '';
        showToast(mode === 'replace'
            ? `Restored ${addedCompanies} companies and ${addedOrders} orders`
            : `Added ${addedCompanies} companies, ${addedOrders} orders${skipped}, ${addedItems} custom items`,
            'success');
    } catch (error) {
        console.error('Import error:', error);
        showToast('Import failed: ' + error.message, 'error');
    } finally {
        pendingBackup = null;
    }
}

// =====================================================================
// ==================== 1. REORDER SUGGESTIONS =========================
// =====================================================================
// Suggests items that sold this year but are low on stock.
// Suggested qty = (this year's sales x plan %) - on hand - already on order.

function normSupplier(s) {
    return String(s || '').toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\b(inc|llc|ll|ltd|co|corp|company|int l|intl|international|the)\b/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

function inventorySuppliers() {
    const set = new Map();
    items.forEach(i => {
        const s = (i.supplier || '').trim();
        if (s && !set.has(s)) set.set(s, normSupplier(s));
    });
    return Array.from(set.keys()).sort((a, b) => a.localeCompare(b));
}

// Find the inventory supplier that goes with a company (remembered, or matched by name)
function supplierForCompany(company) {
    if (!company) return '';
    const list = inventorySuppliers();
    if (company.inventorySupplier && list.includes(company.inventorySupplier)) return company.inventorySupplier;
    const c = normSupplier(company.name);
    if (!c) return '';
    let best = list.find(s => normSupplier(s) === c);
    if (!best) best = list.find(s => { const n = normSupplier(s); return n && (n.includes(c) || c.includes(n)); });
    if (!best) {
        const first = c.split(' ')[0];
        if (first.length >= 4) best = list.find(s => normSupplier(s).split(' ')[0] === first);
    }
    return best || '';
}

// Quantity still on its way, by SKU (orders not yet fully received)
function onOrderBySku() {
    const map = new Map();
    orders.forEach(o => {
        if (orderStatus(o) === 'Received') return;
        (o.items || []).forEach(it => {
            const k = inventoryKey(it);
            const left = Math.max(0, (Number(it.qty) || 0) - (Number(it.received) || 0));
            if (left) map.set(k, (map.get(k) || 0) + left);
        });
    });
    return map;
}

let reorderRows = [];

// One rule for "needs reorder", used by the Reorder tab AND the Inventory list
function reorderSettings() {
    return {
        minSold: Math.max(1, parseInt(document.getElementById('reorder-min-sold')?.value) || 2),
        plan: (parseInt(document.getElementById('reorder-plan')?.value) || 100) / 100
    };
}
// Qty sold that can't be right: average sale price under 25% of cost
// (e.g. 3,999 sold for $39.99 total = a typo at the register)
function salesLookWrong(it) {
    const sold = Number(it.qtySold) || 0, sales = Number(it.sales) || 0, cost = Number(it.cost) || 0;
    return sold >= 2 && cost > 0 && sales > 0 && sales / sold < cost * 0.25;
}

function reorderInfo(it, onOrder, settings) {
    const sold = Number(it.qtySold) || 0;
    if (sold < settings.minSold) return null;
    if (/non.?inventory/i.test(it.description || '')) return null;   // not a real product
    if (!(Number(it.sales) > 0) && !(Number(it.cost) > 0)) return null;   // $0 placeholder like "Accessories Included"
    if (salesLookWrong(it)) return null;                              // flagged "Check sales" instead
    const onHand = Math.max(0, Number(it.onHand) || 0);
    const coming = onOrder.get(inventoryKey(it)) || 0;
    const need = Math.ceil(sold * settings.plan) - onHand - coming;
    const pack = packOf(it);
    return need > 0 ? { sold, onHand: Number(it.onHand) || 0, coming, need, pack, qty: roundToPack(need, pack) } : null;
}
let inventoryNeeds = new Map();   // item id -> reorder info, refreshed on every inventory redraw

function populateReorderSuppliers() {
    const sel = document.getElementById('reorder-supplier');
    if (!sel) return;
    const want = selectedCompany ? supplierForCompany(selectedCompany) : sel.value;
    sel.innerHTML = '<option value="">All suppliers</option>' +
        inventorySuppliers().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    sel.value = want && inventorySuppliers().includes(want) ? want : '';
    updateReorderLinkNote();
}

function updateReorderLinkNote() {
    const note = document.getElementById('reorder-link-note');
    if (!note) return;
    const sup = document.getElementById('reorder-supplier').value;
    if (!selectedCompany) note.textContent = 'Tip: select a company and its items are picked automatically.';
    else if (!sup) note.textContent = `No supplier matched to ${selectedCompany.name}. Pick one and it will be remembered.`;
    else note.textContent = `${selectedCompany.name} uses supplier "${sup}" in the inventory.`;
}

async function onReorderSupplierChange() {
    const sup = document.getElementById('reorder-supplier').value;
    // Remember which inventory supplier belongs to the selected company
    if (selectedCompany && sup && selectedCompany.inventorySupplier !== sup) {
        selectedCompany.inventorySupplier = sup;
        await update('companies', selectedCompany);
    }
    updateReorderLinkNote();
    renderReorder();
}

function renderReorder() {
    const body = document.getElementById('reorder-body');
    if (!body) return;
    const sup = document.getElementById('reorder-supplier').value;
    const settings = reorderSettings();
    const onOrder = onOrderBySku();

    reorderRows = [];
    items.forEach(it => {
        if (sup && (it.supplier || '').trim() !== sup) return;
        const info = reorderInfo(it, onOrder, settings);
        if (info) reorderRows.push({ item: it, ...info, checked: true });
    });
    reorderRows.sort((a, b) => b.sold - a.sold || b.qty - a.qty);

    const LIMIT = 500;
    const shown = reorderRows.slice(0, LIMIT);
    const totalCost = reorderRows.reduce((s, r) => s + r.qty * (Number(r.item.cost) || 0), 0);
    document.getElementById('reorder-summary').textContent = reorderRows.length
        ? `${reorderRows.length} items to reorder · about $${totalCost.toFixed(2)} at cost` +
          (reorderRows.length > LIMIT ? ` · showing top ${LIMIT}, pick a supplier to narrow it down` : '')
        : 'Nothing to reorder with these settings.';

    body.innerHTML = shown.map((r, i) => `
        <tr>
            <td><input type="checkbox" ${r.checked ? 'checked' : ''} onchange="reorderRows[${i}].checked=this.checked" style="width:auto;margin:0;"></td>
            <td>${escapeHtml(r.item.sku)}</td>
            <td>${escapeHtml(r.item.description)}${sup ? '' : `<div style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(r.item.supplier)}</div>`}</td>
            <td style="text-align:right;">${r.sold}</td>
            <td style="text-align:right;${r.onHand <= 0 ? 'color:var(--danger);font-weight:600;' : ''}">${r.onHand}</td>
            <td style="text-align:right;">${r.coming || ''}</td>
            <td><input type="number" min="0" value="${r.qty}" ${r.pack > 1 ? `step="${r.pack}"` : ''} onchange="reorderRows[${i}].qty=Math.max(0,parseInt(this.value)||0)" style="width:70px;margin:0;padding:0.4rem;">
                ${r.pack > 1 ? `<div class="sub">pack of ${r.pack}</div>` : ''}</td>
        </tr>`).join('');
}

function reorderSelectAll(on) {
    reorderRows.forEach(r => r.checked = on);
    renderReorderChecks();
}
function renderReorderChecks() {
    document.querySelectorAll('#reorder-body input[type=checkbox]').forEach((cb, i) => {
        if (reorderRows[i]) cb.checked = reorderRows[i].checked;
    });
}

function addReorderToOrder() {
    const picked = reorderRows.slice(0, 500).filter(r => r.checked && r.qty > 0);
    if (!picked.length) { showToast('Check at least one item', 'error'); return; }
    let added = 0, merged = 0;
    picked.forEach(r => {
        const it = r.item;
        const idx = currentOrder.items.findIndex(l => l.id === it.id || (it.sku && l.sku === it.sku));
        if (idx >= 0) {
            currentOrder.items[idx].qty += r.qty;
            currentOrder.items[idx].lineTotal = currentOrder.items[idx].cost * currentOrder.items[idx].qty;
            merged++;
        } else {
            currentOrder.items.push({
                id: it.id, sku: it.sku, supplier: it.supplier, description: it.description,
                onHand: it.onHand, qtySold: it.qtySold, sales: it.sales, lastSold: it.lastSold,
                cost: Number(it.cost) || 0, qty: r.qty, lineTotal: (Number(it.cost) || 0) * r.qty
            });
            added++;
        }
    });
    renderOrderItems();
    updateOrderTotals();
    switchTab('builder');
    showToast(`${added} items added to the order` + (merged ? `, ${merged} already there (qty increased)` : '') +
        (selectedCompany ? '' : '. Select a company before saving.'), selectedCompany ? 'success' : 'info');
}

// =====================================================================
// ==================== 2. ORDER STATUS & RECEIVING ====================
// =====================================================================

function orderStatus(o) { return o.status || 'Placed'; }

function statusBadge(o) {
    const s = orderStatus(o);
    const cls = s === 'Received' ? 'received' : s === 'Partly received' ? 'partial' : 'placed';
    return `<span class="status-badge ${cls}">${s}</span>`;
}

let receivingOrderId = null;

function showReceiveModal(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    receivingOrderId = orderId;
    document.getElementById('receive-title').textContent =
        `Receive Order #${o.id} · ${o.companyName} · ${new Date(o.date).toLocaleDateString()}`;
    document.getElementById('receive-body').innerHTML = o.items.map((it, i) => `
        <tr>
            <td>${escapeHtml(it.sku)}</td>
            <td>${escapeHtml(it.description)}</td>
            <td style="text-align:right;">${it.qty}</td>
            <td><input type="number" min="0" class="recv-qty" data-i="${i}" value="${Number(it.received) || 0}" style="width:70px;margin:0;padding:0.4rem;"></td>
        </tr>`).join('');
    document.getElementById('receive-discrepancy').checked = true;
    document.getElementById('receive-modal').classList.add('show');
}

function receiveAllArrived() {
    const o = orders.find(x => x.id === receivingOrderId);
    if (!o) return;
    document.querySelectorAll('.recv-qty').forEach(inp => { inp.value = o.items[+inp.dataset.i].qty; });
}

async function saveReceiving() {
    const o = orders.find(x => x.id === receivingOrderId);
    if (!o) return;
    document.querySelectorAll('.recv-qty').forEach(inp => {
        o.items[+inp.dataset.i].received = Math.max(0, parseInt(inp.value) || 0);
    });
    const anyIn = o.items.some(it => (it.received || 0) > 0);
    const allIn = o.items.every(it => (it.received || 0) >= it.qty);
    o.status = allIn ? 'Received' : anyIn ? 'Partly received' : 'Placed';
    o.receivedDate = anyIn ? new Date().toISOString() : '';

    try {
        await update('orders', o);

        // Missing or extra items -> discrepancy on the company
        const diffs = o.items.filter(it => (it.received || 0) !== it.qty && anyIn);
        if (diffs.length && document.getElementById('receive-discrepancy').checked) {
            const company = companies.find(c => c.id === o.companyId);
            if (company) {
                const lines = diffs.map(it => {
                    const r = it.received || 0;
                    return `${it.sku} ${it.description}: ordered ${it.qty}, received ${r} (${r < it.qty ? (it.qty - r) + ' missing' : (r - it.qty) + ' extra'})`;
                });
                company.discrepancies = company.discrepancies || [];
                company.discrepancies.push({
                    description: `Order #${o.id} of ${new Date(o.date).toLocaleDateString()}: ` + lines.join('; '),
                    date: new Date().toISOString(),
                    orderId: o.id
                });
                await update('companies', company);
                companies = await getAll('companies');
            }
        }

        orders = await getAll('orders');
        closeModal('receive-modal');
        filterItems(true);
        renderOrdersLedger();
        renderCompanies();
        if (selectedCompany) selectCompany(selectedCompany.id);
        if (!document.getElementById('reorder-content').classList.contains('hidden')) renderReorder();
        showToast(`Order #${o.id}: ${o.status}` + (diffs.length && document.getElementById('receive-discrepancy').checked ? ' · discrepancy recorded' : ''), 'success');
    } catch (error) {
        console.error(error);
        showToast('Could not save receiving', 'error');
    }
}

// =====================================================================
// ==================== 3. OVERDUE INVOICE ALERTS ======================
// =====================================================================

let invoiceAlertsOpen = false;

function localDay(d) {
    const x = new Date(d);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate());
}

function collectInvoiceAlerts() {
    const today = localDay(new Date());
    const list = [];
    companies.forEach(c => (c.invoices || []).forEach((inv, index) => {
        if (inv.status !== 'Outstanding' || !inv.dueDate) return;
        const days = Math.round((localDay(inv.dueDate) - today) / 86400000);
        if (days <= 7) list.push({ company: c, inv, index, days });
    }));
    return list.sort((a, b) => a.days - b.days);
}

function renderInvoiceAlerts() {
    const box = document.getElementById('invoice-alerts');
    if (!box) return;
    const list = collectInvoiceAlerts();
    if (!list.length) { box.classList.add('hidden'); return; }

    const overdue = list.filter(a => a.days < 0);
    const soon = list.filter(a => a.days >= 0);
    const sum = arr => arr.reduce((s, a) => s + (Number(a.inv.amount) || 0), 0);
    const parts = [];
    if (overdue.length) parts.push(`<strong>${overdue.length} overdue</strong> · $${sum(overdue).toFixed(2)}`);
    if (soon.length) parts.push(`<strong>${soon.length} due within 7 days</strong> · $${sum(soon).toFixed(2)}`);

    const rows = list.map(a => {
        const when = a.days < 0 ? `${-a.days} day${a.days === -1 ? '' : 's'} overdue`
            : a.days === 0 ? 'due today' : `due in ${a.days} day${a.days === 1 ? '' : 's'}`;
        return `
        <div class="alert-row ${a.days < 0 ? 'overdue' : ''}">
            <span class="alert-company">${escapeHtml(a.company.name)}</span>
            <span>Invoice ${escapeHtml(a.inv.number)}</span>
            <span>$${(Number(a.inv.amount) || 0).toFixed(2)}</span>
            <span>${new Date(a.inv.dueDate).toLocaleDateString()} · <em>${when}</em></span>
            <span class="alert-actions">
                <button class="btn-close" onclick="openCompanyFromAlert(${a.company.id})">Open</button>
                <button class="btn-edit" onclick="toggleInvoiceStatus(${a.company.id}, ${a.index})">Mark paid</button>
            </span>
        </div>`;
    }).join('');

    box.classList.remove('hidden');
    box.classList.toggle('has-overdue', overdue.length > 0);
    box.innerHTML = `
        <div class="alert-summary" onclick="invoiceAlertsOpen=!invoiceAlertsOpen; renderInvoiceAlerts();">
            <span>Invoices: ${parts.join(' &nbsp;·&nbsp; ')}</span>
            <span class="alert-toggle">${invoiceAlertsOpen ? 'Hide list' : 'Show list'}</span>
        </div>
        ${invoiceAlertsOpen ? `<div class="alert-list">${rows}</div>` : ''}`;
}

function openCompanyFromAlert(id) {
    selectCompany(id);
    document.getElementById('companies-panel').scrollIntoView({ behavior: 'smooth' });
}

// Small "Reorder N" tag shown next to the description in the Inventory list
function reorderFlagHTML(item) {
    const info = inventoryNeeds.get(item.id);
    if (!info) {
        return salesLookWrong(item)
            ? ` <span class="reorder-flag check" title="${escapeHtml(`POS says ${item.qtySold} sold for $${(Number(item.sales) || 0).toFixed(2)} total. Probably a typo at the register, so no reorder is suggested. Check it in the POS.`)}">Check sales</span>`
            : '';
    }
    const tip = `Sold ${info.sold} this year, ${info.onHand} on hand` + (info.coming ? `, ${info.coming} on order` : '') +
        (info.pack > 1 ? `. Needs ${info.need}, rounded up to packs of ${info.pack}` : '') + '. Click to add.';
    return ` <span class="reorder-flag" title="${escapeHtml(tip)}">Reorder ${info.qty}</span>`;
}

// When the Reorder settings change, the flags in the Inventory list follow
function onReorderSettingsChange() {
    renderReorder();
    filterItems(true);
}

// Keep the "In order: N" tags in step with every change to the order table
(function () {
    const baseRender = renderOrderItems;
    renderOrderItems = function () { baseRender.apply(this, arguments); refreshInOrderTags(); };
    const baseRow = updateOrderRowInDOM;
    updateOrderRowInDOM = function () { baseRow.apply(this, arguments); refreshInOrderTags(); };
})();

// =====================================================================
// ==================== STORE INFO (for purchase orders) ===============
// =====================================================================
const STORE_KEY = 'lcStoreInfo';
// Every Store Info field in Settings (input ids are "st-" + name)
const STORE_FIELDS = ['name', 'address', 'phone', 'email', 'website', 'taxId', 'orderingGroup', 'memo', 'shipTo'];
function getStoreInfo() {
    let info = {};
    try { info = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { info = {}; }
    return { name: 'La Casa De Los Trucos', address: '', phone: '', email: '', website: '', taxId: '', orderingGroup: '', memo: '', shipTo: '', ...info };
}
function setStoreInfo(info) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(info)); } catch (e) { /* storage blocked */ }
}
function showStoreModal() { showSettingsModal('store'); }

// =====================================================================
// ==================== CASE PACKS =====================================
// =====================================================================
function packOf(item) {
    const p = parseInt(item && item.casePack);
    return p > 1 ? p : 1;
}
function roundToPack(qty, pack) {
    return pack > 1 ? Math.ceil(qty / pack) * pack : qty;
}
// Order lines carry a copy of the item; look up the live item for its case pack
function inventoryItemFor(line) {
    if (!line) return null;
    const byId = items.find(i => i.id === line.id);
    if (byId && inventoryKey(byId) === inventoryKey(line)) return byId;
    const key = inventoryKey(line);
    return items.find(i => inventoryKey(i) === key) || byId || null;
}
async function saveCasePack(itemId, value) {
    const it = items.find(i => i.id === itemId);
    if (!it) return;
    const p = parseInt(value);
    it.casePack = p > 1 ? p : null;
    if (!it.casePack) delete it.casePack;
    await update('items', it);
    // Redraw the window so the suggestion and buttons use the new pack,
    // FIX: but keep the quantity the user already typed
    const qtyInput = document.getElementById('item-qty');
    const typedQty = qtyInput.value;
    showItemModal(itemId);
    qtyInput.value = typedQty;
    updateItemModalButtons();
    setTimeout(() => document.getElementById('item-pack')?.focus(), 60);   // stay on the case pack box
    filterItems(true);
    renderOrderItems();
    showToast(it.casePack ? `Saved: sold in packs of ${it.casePack}` : 'Case pack removed', 'success');
}
function packHintHTML(item, qty) {
    const pack = packOf(item);
    if (pack <= 1 || !qty || qty % pack === 0) return '';
    const up = roundToPack(qty, pack);
    return `Not a full pack: ${qty} is ${(qty / pack).toFixed(2).replace(/\.?0+$/, '')} packs of ${pack}.
        <a href="#" onclick="event.preventDefault(); document.getElementById('item-qty').value=${up}; updateItemModalButtons();">Round up to ${up}</a>`;
}

// =====================================================================
// ==================== MINIMUM ORDER / FREE FREIGHT ===================
// =====================================================================
function renderOrderThresholds() {
    const box = document.getElementById('order-thresholds');
    if (!box) return;
    const c = selectedCompany;
    const total = Number(currentOrder.total) || 0;
    const msgs = [];
    if (c && Number(c.minOrder) > 0) {
        const left = c.minOrder - total;
        msgs.push(left > 0
            ? `<div class="threshold warn">Minimum order $${Number(c.minOrder).toFixed(2)}: <strong>$${left.toFixed(2)} more needed</strong></div>`
            : `<div class="threshold ok">✓ Minimum order of $${Number(c.minOrder).toFixed(2)} reached</div>`);
    }
    if (c && Number(c.freeFreight) > 0) {
        const left = c.freeFreight - total;
        const pct = Math.min(100, Math.round(total / c.freeFreight * 100));
        msgs.push(left > 0
            ? `<div class="threshold info"><strong>$${left.toFixed(2)} more for free shipping</strong> (free at $${Number(c.freeFreight).toFixed(2)})
                 <div class="progress"><div style="width:${pct}%"></div></div></div>`
            : `<div class="threshold ok">✓ Free shipping reached ($${Number(c.freeFreight).toFixed(2)})</div>`);
    }
    box.innerHTML = msgs.join('');
}

// =====================================================================
// ==================== PAYMENT TERMS ==================================
// =====================================================================
function termsLabel(days) {
    if (days === '' || days == null || isNaN(parseInt(days))) return '';
    const d = parseInt(days);
    return d === 0 ? 'Due on receipt' : `Net ${d}`;
}
function addDaysISO(days, from = new Date()) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + parseInt(days));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function onTermsSelectChange() {
    const sel = document.getElementById('c-terms');
    document.getElementById('c-terms-custom').classList.toggle('hidden', sel.value !== 'custom');
}
function readTermsFromForm() {
    const v = document.getElementById('c-terms').value;
    if (v === '') return '';
    if (v === 'custom') {
        const n = parseInt(document.getElementById('c-terms-custom').value);
        return n >= 0 ? n : '';
    }
    return parseInt(v);
}
function fillTermsInForm(days) {
    const sel = document.getElementById('c-terms');
    const custom = document.getElementById('c-terms-custom');
    const preset = ['', '0', '10', '15', '30', '45', '60', '90'];
    const v = days === '' || days == null ? '' : String(days);
    if (preset.includes(v)) { sel.value = v; custom.value = ''; }
    else { sel.value = 'custom'; custom.value = v; }
    onTermsSelectChange();
}

// =====================================================================
// ==================== SUPPLIER FILTER (Inventory) ====================
// =====================================================================
let supplierListSignature = '';
function populateSupplierFilters() {
    const list = inventorySuppliers();
    const sig = list.length + '|' + (list[0] || '') + '|' + (list[list.length - 1] || '');
    const fill = (id, extra) => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const keep = sel.value;
        sel.innerHTML = `<option value="">All suppliers</option>${extra}` +
            list.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
        sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
    };
    if (sig !== supplierListSignature) {
        supplierListSignature = sig;
        fill('inv-supplier-filter', '<option value="__company">Selected company</option>');
        fill('dead-supplier', '<option value="__company">Selected company</option>');
    }
    // Show which supplier "Selected company" stands for
    ['inv-supplier-filter', 'dead-supplier'].forEach(id => {
        const opt = document.querySelector(`#${id} option[value="__company"]`);
        if (!opt) return;
        const sup = selectedCompany ? supplierForCompany(selectedCompany) : '';
        opt.textContent = selectedCompany
            ? `Selected company (${sup || 'no supplier matched'})`
            : 'Selected company (none selected)';
    });
}
function resolveSupplierFilter(id) {
    const v = document.getElementById(id)?.value || '';
    if (v !== '__company') return { active: !!v, supplier: v };
    const sup = selectedCompany ? supplierForCompany(selectedCompany) : '';
    return { active: true, supplier: sup };
}

// =====================================================================
// ==================== PURCHASE ORDER: print / PDF / email ============
// =====================================================================
function nextPONumber(date = new Date()) {
    const year = new Date(date).getFullYear();
    let max = 0;
    orders.forEach(o => {
        const m = String(o.poNumber || '').match(new RegExp(`^PO-${year}-(\\d+)$`));
        if (m) max = Math.max(max, parseInt(m[1]));
    });
    return `PO-${year}-${String(max + 1).padStart(3, '0')}`;
}

// The order shown in the builder, as a PO (gives it a PO number if it has none)
function builderAsPO() {
    if (!selectedCompany) { showToast('Select a company first', 'error'); return null; }
    if (!currentOrder.items.length) { showToast('Add items to the order first', 'error'); return null; }
    const poInput = document.getElementById('order-po');
    const dateVal = document.getElementById('order-date').value;
    if (!poInput.value.trim()) poInput.value = nextPONumber(dateVal ? dateVal + 'T12:00:00' : new Date());
    return {
        company: selectedCompany,
        order: {
            poNumber: poInput.value.trim(),
            date: dateVal ? new Date(dateVal + 'T12:00:00').toISOString() : new Date().toISOString(),
            items: currentOrder.items,
            total: currentOrder.total,
            saved: !!editingOrderId
        }
    };
}
function savedAsPO(orderId) {
    const order = orders.find(o => o.id === orderId);
    const company = order && companies.find(c => c.id === order.companyId);
    if (!order || !company) { showToast('Order not found', 'error'); return null; }
    return { company, order: { ...order, poNumber: order.poNumber || `PO-${new Date(order.date).getFullYear()}-#${order.id}`, saved: true } };
}

function poHTML({ company, order }) {
    const s = getStoreInfo();
    const logo = new URL('logo.png', location.href).href;
    const money = v => '$' + (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const nl = v => escapeHtml(v || '').replace(/\n/g, '<br>');
    const rows = order.items.map(it => `
        <tr><td>${escapeHtml(it.sku)}</td><td>${escapeHtml(it.description)}</td>
            <td class="r">${it.qty}</td><td class="r">${money(it.cost)}</td><td class="r">${money(it.cost * it.qty)}</td></tr>`).join('');
    const units = order.items.reduce((n, it) => n + (Number(it.qty) || 0), 0);
    const terms = termsLabel(company.termsDays);
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(order.poNumber)} - ${escapeHtml(company.name)}</title>
<style>
  *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1e293b;margin:0;padding:32px;font-size:13px}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1e293b;padding-bottom:16px}
  .store{display:flex;gap:14px;align-items:flex-start} .store img{height:56px} .store h1{margin:0 0 4px;font-size:18px}
  .po{text-align:right} .po h2{margin:0;font-size:24px;letter-spacing:.08em} .po div{margin-top:3px}
  .boxes{display:flex;gap:16px;margin:20px 0} .box{flex:1;border:1px solid #cbd5e1;border-radius:6px;padding:10px 12px}
  .box h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b}
  table{width:100%;border-collapse:collapse} th{background:#f1f5f9;text-align:left;font-size:11px;text-transform:uppercase;padding:8px;border-bottom:1px solid #cbd5e1}
  td{padding:7px 8px;border-bottom:1px solid #e2e8f0} .r{text-align:right} tfoot td{font-weight:700;border-bottom:none;font-size:15px}
  .foot{margin-top:28px;color:#64748b;font-size:12px}
  .memo{margin-top:18px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc} .bar{position:sticky;top:0;background:#eff6ff;border:1px solid #bfdbfe;padding:10px;margin:-16px -16px 20px;border-radius:6px}
  .bar button{font-size:14px;padding:6px 14px;margin-right:8px;cursor:pointer}
  @media print{.bar{display:none} body{padding:0}}
</style></head><body>
<div class="bar">This is your purchase order. Use <b>Print</b>, or choose <b>Save as PDF</b> as the printer to attach it to an email.
  <br><button onclick="window.print()">Print / Save as PDF</button><button onclick="window.close()">Close</button></div>
<div class="top">
  <div class="store"><img src="${logo}" onerror="this.style.display='none'">
    <div><h1>${escapeHtml(s.name)}</h1>${nl(s.address)}${s.phone ? `<br>${escapeHtml(s.phone)}` : ''}${s.email ? `<br>${escapeHtml(s.email)}` : ''}${s.website ? `<br>${escapeHtml(s.website)}` : ''}</div></div>
  <div class="po"><h2>PURCHASE ORDER</h2><div><b>${escapeHtml(order.poNumber)}</b></div>
    <div>Date: ${new Date(order.date).toLocaleDateString()}</div>${terms ? `<div>Terms: ${escapeHtml(terms)}</div>` : ''}</div>
</div>
<div class="boxes">
  <div class="box"><h3>Vendor</h3><b>${escapeHtml(company.name)}</b><br>${nl(company.address)}
    ${company.rep ? `<br>Attn: ${escapeHtml(company.rep)}` : ''}${company.phone ? `<br>${escapeHtml(company.phone)}` : ''}${company.email ? `<br>${escapeHtml(company.email)}` : ''}</div>
  <div class="box"><h3>Ship to</h3><b>${escapeHtml(s.name)}</b><br>${nl(s.shipTo || s.address)}</div>
  <div class="box"><h3>Our account</h3>Customer #: <b>${escapeHtml(company.customerNumber)}</b>
    ${s.orderingGroup ? `<br>Ordering group: <b>${escapeHtml(s.orderingGroup)}</b>` : ''}
    ${s.taxId ? `<br>Tax ID: <b>${escapeHtml(s.taxId)}</b>` : ''}
    <br>${order.items.length} lines · ${units} units</div>
</div>
<table><thead><tr><th>SKU</th><th>Description</th><th class="r">Qty</th><th class="r">Unit cost</th><th class="r">Total</th></tr></thead>
<tbody>${rows}</tbody><tfoot><tr><td colspan="4" class="r">Total</td><td class="r">${money(order.total)}</td></tr></tfoot></table>
${s.memo ? `<div class="memo"><b>Memo:</b> ${nl(s.memo)}</div>` : ''}
<div class="foot">Please confirm this order and reference ${escapeHtml(order.poNumber)} on your invoice and packing slip.</div>
</body></html>`;
}

function openPOWindow(po) {
    const w = window.open('', '_blank');
    if (!w) { showToast('Your browser blocked the PO window. Allow pop-ups for this page.', 'error'); return null; }
    w.document.open();
    w.document.write(poHTML(po));
    w.document.close();
    return w;
}

function poEmailText({ company, order }, withLines) {
    const s = getStoreInfo();
    const money = v => '$' + (Number(v) || 0).toFixed(2);
    const lines = order.items.map(it => `${it.qty} x ${it.sku} - ${it.description} @ ${money(it.cost)} = ${money(it.cost * it.qty)}`);
    return [
        `Hello${company.rep ? ' ' + company.rep : ''},`,
        '',
        `Please find our purchase order ${order.poNumber}${withLines ? ' below' : ' attached'}.`,
        '',
        `Customer #: ${company.customerNumber}`,
        s.orderingGroup ? `Ordering group: ${s.orderingGroup}` : null,
        s.taxId ? `Tax ID: ${s.taxId}` : null,
        `Order date: ${new Date(order.date).toLocaleDateString()}`,
        termsLabel(company.termsDays) ? `Terms: ${termsLabel(company.termsDays)}` : null,
        '',
        ...(withLines ? [...lines, ''] : [`${order.items.length} lines (see attached PDF).`, '']),
        `Total: ${money(order.total)}`,
        '',
        s.memo ? `Memo: ${s.memo}` : null,
        s.memo ? '' : null,
        'Please confirm the order and reference the PO number on your invoice.',
        '',
        'Thank you,',
        s.name,
        s.phone || null,
        s.website || null
    ].filter(l => l !== null).filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

function emailPO(po) {
    if (!po) return;
    if (!po.company.email) showToast(`No email saved for ${po.company.name}. Add it with Edit on the company.`, 'info');
    const subject = `Purchase Order ${po.order.poNumber} - ${getStoreInfo().name}`;
    let body = poEmailText(po, true);
    let attachNote = false;
    // Email links get cut off when very long: send a summary and attach the PDF instead
    if (encodeURIComponent(body).length > 1800) { body = poEmailText(po, false); attachNote = true; }
    window.location.href = `mailto:${encodeURIComponent(po.company.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (attachNote) {
        openPOWindow(po);
        showToast('Order is long: save the PO window as PDF and attach it to the email', 'info');
    }
}

function printBuilderPO() { const po = builderAsPO(); if (po) openPOWindow(po); }
function emailBuilderPO() { const po = builderAsPO(); if (po) emailPO(po); }
function printSavedPO(id) { const po = savedAsPO(id); if (po) openPOWindow(po); }
function emailSavedPO(id) { const po = savedAsPO(id); if (po) emailPO(po); }

// =====================================================================
// ==================== COST CHANGE ALERTS =============================
// =====================================================================
const COST_KEY = 'lcCostChanges';
function saveCostReport(report) {
    try { localStorage.setItem(COST_KEY, JSON.stringify(report)); } catch (e) { /* too big or blocked */ }
    lastCostReport = report;
}
let lastCostReport = null;
function loadCostReport() {
    if (lastCostReport) return lastCostReport;
    try { lastCostReport = JSON.parse(localStorage.getItem(COST_KEY) || 'null'); } catch (e) { lastCostReport = null; }
    return lastCostReport;
}
function showCostChanges() {
    const r = loadCostReport();
    const body = document.getElementById('cost-body');
    const sum = document.getElementById('cost-summary');
    if (!r) {
        sum.textContent = 'No comparison yet. The next time you click Upload Items, cost increases will be listed here.';
        body.innerHTML = '';
    } else {
        sum.innerHTML = `${escapeHtml(r.file)} uploaded ${new Date(r.date).toLocaleString()}: <strong>${r.up.length} items went up</strong>` +
            (r.downCount ? `, ${r.downCount} went down` : '') + '.';
        body.innerHTML = r.up.slice(0, 1000).map(c => `
            <tr><td>${escapeHtml(c.sku)}</td><td>${escapeHtml(c.description)}<div class="sub">${escapeHtml(c.supplier)}</div></td>
                <td class="r">$${c.old.toFixed(2)}</td><td class="r">$${c.now.toFixed(2)}</td>
                <td class="r up">+${c.pct.toFixed(1)}%</td></tr>`).join('') +
            (r.up.length > 1000 ? `<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Showing 1,000 of ${r.up.length}. Download for the full list.</td></tr>` : '');
    }
    document.getElementById('cost-modal').classList.add('show');
}
function downloadCostChanges() {
    const r = loadCostReport();
    if (!r || !r.up.length) return showToast('No cost increases to download', 'info');
    const ws = XLSX.utils.aoa_to_sheet([
        ['SKU', 'Supplier', 'Description', 'Old cost', 'New cost', 'Change %'],
        ...r.up.map(c => [c.sku, c.supplier, c.description, c.old, c.now, Math.round(c.pct * 10) / 10])
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Cost increases');
    XLSX.writeFile(wb, `Cost_increases_${new Date(r.date).toISOString().slice(0, 10)}.xlsx`);
}

// =====================================================================
// ==================== DEAD STOCK =====================================
// =====================================================================
let deadRows = [];
function renderDeadStock() {
    const body = document.getElementById('dead-body');
    if (!body) return;
    populateSupplierFilters();
    const years = parseInt(document.getElementById('dead-years').value) || 2;
    const includeNever = document.getElementById('dead-never').checked;
    const sf = resolveSupplierFilter('dead-supplier');
    const now = new Date();
    const cutoff = `${now.getFullYear() - years}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    deadRows = items.filter(it => {
        if ((Number(it.onHand) || 0) <= 0) return false;
        if (sf.active && (it.supplier || '').trim() !== sf.supplier) return false;
        const last = normalizeDate(it.lastSold || '');
        if (!last) return includeNever;
        return last < cutoff;
    }).map(it => ({ it, value: (Number(it.onHand) || 0) * (Number(it.cost) || 0) }))
      .sort((a, b) => b.value - a.value);

    const total = deadRows.reduce((s, r) => s + r.value, 0);
    const units = deadRows.reduce((s, r) => s + (Number(r.it.onHand) || 0), 0);
    document.getElementById('dead-summary').innerHTML = deadRows.length
        ? `<strong>${deadRows.length.toLocaleString()} items</strong> · ${units.toLocaleString()} units · <strong>$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong> at cost`
        : 'No dead stock with these settings.';
    body.innerHTML = deadRows.slice(0, 500).map(r => `
        <tr onclick="showItemModal(${r.it.id})">
            <td>${escapeHtml(r.it.sku)}</td>
            <td>${escapeHtml(r.it.description)}${sf.active ? '' : `<div class="sub">${escapeHtml(r.it.supplier)}</div>`}</td>
            <td class="r">${r.it.onHand}</td>
            <td>${r.it.lastSold ? escapeHtml(normalizeDate(r.it.lastSold)) : '<em>never</em>'}</td>
            <td class="r">$${(Number(r.it.cost) || 0).toFixed(2)}</td>
            <td class="r"><strong>$${r.value.toFixed(2)}</strong></td>
        </tr>`).join('') +
        (deadRows.length > 500 ? `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Showing the 500 with the most money tied up. Download for all ${deadRows.length.toLocaleString()}.</td></tr>` : '');
}
function downloadDeadStock() {
    if (!deadRows.length) return showToast('Nothing to download', 'info');
    const ws = XLSX.utils.aoa_to_sheet([
        ['SKU', 'Supplier', 'Description', 'On hand', 'Last sold', 'Cost', 'Value at cost'],
        ...deadRows.map(r => [r.it.sku, r.it.supplier, r.it.description, r.it.onHand,
            r.it.lastSold ? normalizeDate(r.it.lastSold) : 'never', Number(r.it.cost) || 0, Math.round(r.value * 100) / 100])
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dead stock');
    XLSX.writeFile(wb, `Dead_stock_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// NEW: wrap every place the search text appears in a highlight (any upper/lower case).
// The text is escaped first, so names with < or & still display safely.
function highlightMatch(text, term) {
    const str = String(text == null ? '' : text);
    const words = String(term || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return escapeHtml(str);
    // Mark every character that belongs to any search word, then wrap each marked run
    const lower = str.toLowerCase();
    const hit = new Array(str.length).fill(false);
    words.forEach(w => {
        let i = 0;
        while ((i = lower.indexOf(w, i)) !== -1) {
            for (let k = i; k < i + w.length; k++) hit[k] = true;
            i += w.length;
        }
    });
    let out = '', k = 0;
    while (k < str.length) {
        const on = hit[k];
        let j = k;
        while (j < str.length && hit[j] === on) j++;
        const part = escapeHtml(str.slice(k, j));
        out += on ? '<mark class="search-hit">' + part + '</mark>' : part;
        k = j;
    }
    return out;
}

// =====================================================================
// ==================== ORDER AUTOSAVE (every 5 minutes) ===============
// =====================================================================
// While an order is open in the Order Builder, a draft is saved every 5 minutes
// (and when the page is closed). It is NOT a saved order: it doesn't show in the
// Ledger or count as "on order". If the program is closed before you click Save,
// it offers to restore the draft next time.
const DRAFT_KEY = 'lcOrderDraft';
// Interval and on/off come from Settings
let lastDraftSignature = '';

function currentDraft() {
    if (!currentOrder.items.length) return null;
    return {
        companyId: selectedCompany ? selectedCompany.id : null,
        companyName: selectedCompany ? selectedCompany.name : '',
        editingOrderId: editingOrderId || null,
        date: document.getElementById('order-date').value,
        poNumber: document.getElementById('order-po').value,
        items: currentOrder.items
    };
}

function autosaveOrder(reason = 'timer') {
    const draft = currentDraft();
    if (!draft) return;
    const sig = JSON.stringify(draft);
    if (sig === lastDraftSignature) return;          // nothing changed since the last autosave
    try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
        lastDraftSignature = sig;
        const el = document.getElementById('autosave-status');
        if (el) el.textContent = `Draft autosaved at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } catch (e) {
        console.warn('Autosave failed', e);
    }
}

function clearOrderDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
    lastDraftSignature = '';
    const el = document.getElementById('autosave-status');
    if (el) el.textContent = '';
}

function readOrderDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { return null; }
}

// Shown in the Order Builder when the program opens and an unsaved draft exists
function checkOrderDraft() {
    const d = readOrderDraft();
    const box = document.getElementById('draft-banner');
    if (!box) return;
    if (!d || !Array.isArray(d.items) || !d.items.length) { box.classList.add('hidden'); return; }
    const total = d.items.reduce((s, i) => s + (Number(i.lineTotal) || 0), 0);
    const when = d.savedAt ? new Date(d.savedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    box.innerHTML = `
        <div><strong>Unsaved order found</strong>${d.companyName ? ` for ${escapeHtml(d.companyName)}` : ''}:
            ${d.items.length} item${d.items.length === 1 ? '' : 's'}, $${total.toFixed(2)}${when ? ` · autosaved ${escapeHtml(when)}` : ''}
            ${d.editingOrderId ? ' · changes to a saved order' : ''}</div>
        <div class="draft-actions">
            <button class="btn-add" onclick="restoreOrderDraft()">Restore</button>
            <button class="btn-close" onclick="discardOrderDraft()">Discard</button>
        </div>`;
    box.classList.remove('hidden');
}

function restoreOrderDraft() {
    const d = readOrderDraft();
    if (!d) return;
    if (currentOrder.items.length && !confirm('Replace the order that is open now with the restored draft?')) return;
    if (d.companyId && companies.some(c => c.id === d.companyId)) selectCompany(d.companyId);
    currentOrder = { items: d.items.map(i => ({ ...i })), subtotal: 0, total: 0 };
    editingOrderId = d.editingOrderId && orders.some(o => o.id === d.editingOrderId) ? d.editingOrderId : null;
    if (d.date) document.getElementById('order-date').value = d.date;
    document.getElementById('order-po').value = d.poNumber || '';
    renderOrderItems();
    updateOrderTotals();
    switchTab('builder');
    document.getElementById('draft-banner').classList.add('hidden');
    lastDraftSignature = JSON.stringify(currentDraft());
    showToast('Draft restored. Click Save Order to keep it.', 'success');
}

function discardOrderDraft() {
    if (!confirm('Discard the unsaved order? This cannot be undone.')) return;
    clearOrderDraft();
    document.getElementById('draft-banner').classList.add('hidden');
    showToast('Draft discarded', 'info');
}

// Opening a saved order to look at it doesn't count as a change
(function () {
    const baseLoad = loadOrder;
    loadOrder = function () {
        baseLoad.apply(this, arguments);
        lastDraftSignature = JSON.stringify(currentDraft());
    };
})();

window.addEventListener('beforeunload', () => { if (getSettings().autosave) autosaveOrder('close'); });


// =====================================================================
// ==================== SETTINGS =======================================
// =====================================================================
const SETTINGS_KEY = 'lcSettings';
const DEFAULT_SETTINGS = { autosave: true, autosaveMinutes: 5, layout: 'auto' };

function getSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    return { ...DEFAULT_SETTINGS, ...saved };
}
function setSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* storage blocked */ }
}

let autosaveTimer = null;
function startAutosave() {
    if (autosaveTimer) clearInterval(autosaveTimer);
    autosaveTimer = null;
    const st = getSettings();
    const el = document.getElementById('autosave-status');
    if (!st.autosave) {
        if (el) el.textContent = 'Autosave is off (Settings)';
        return;
    }
    const minutes = Math.max(1, parseInt(st.autosaveMinutes) || 5);
    autosaveTimer = setInterval(() => autosaveOrder('timer'), minutes * 60 * 1000);
    if (el && !el.textContent.startsWith('Draft autosaved')) el.textContent = `Autosave every ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function showSettingsModal(tab = 'general') {
    const st = getSettings();
    document.getElementById('set-autosave').checked = !!st.autosave;
    const minSel = document.getElementById('set-autosave-minutes');
    if (![...minSel.options].some(o => +o.value === +st.autosaveMinutes)) {
        minSel.insertAdjacentHTML('beforeend', `<option value="${st.autosaveMinutes}">${st.autosaveMinutes} minutes</option>`);
    }
    minSel.value = String(st.autosaveMinutes);
    onAutosaveToggle();
    document.getElementById('set-layout').value = st.layout || 'auto';
    const info = getStoreInfo();
    STORE_FIELDS.forEach(f => { document.getElementById('st-' + f).value = info[f] || ''; });
    switchSettingsTab(tab);
    document.getElementById('settings-modal').classList.add('show');
}

function switchSettingsTab(tab) {
    ['general', 'store', 'data'].forEach(t => {
        document.getElementById('stab-' + t).classList.toggle('active', t === tab);
        document.getElementById('spane-' + t).classList.toggle('hidden', t !== tab);
    });
}

function onAutosaveToggle() {
    document.getElementById('set-autosave-minutes').disabled = !document.getElementById('set-autosave').checked;
}

function saveSettings() {
    const st = {
        ...getSettings(),
        autosave: document.getElementById('set-autosave').checked,
        autosaveMinutes: parseInt(document.getElementById('set-autosave-minutes').value) || 5,
        layout: document.getElementById('set-layout').value || 'auto'
    };
    setSettings(st);
    const info = {};
    STORE_FIELDS.forEach(f => { info[f] = document.getElementById('st-' + f).value.trim(); });
    if (!info.name) info.name = 'La Casa De Los Trucos';
    setStoreInfo(info);
    const el = document.getElementById('autosave-status');
    if (el) el.textContent = '';
    startAutosave();
    applyLayout();
    closeModal('settings-modal');
    showToast(st.autosave ? `Settings saved · autosave every ${st.autosaveMinutes} min` : 'Settings saved · autosave is off', 'success');
}


// =====================================================================
// ==================== SAVE STATUS IN THE ORDER BUILDER ===============
// =====================================================================
// Shows "Saved 5:10 PM · PO-2026-003" or "Unsaved changes" next to the company name
let lastSavedSignature = '';
let lastSavedAt = null;

function orderSignatureForSave() {
    return JSON.stringify({
        c: selectedCompany ? selectedCompany.id : null,
        d: document.getElementById('order-date').value,
        p: document.getElementById('order-po').value.trim(),
        i: currentOrder.items.map(i => [inventoryKey(i), i.qty, i.cost])
    });
}

function updateBuilderStatus() {
    const head = document.getElementById('order-company');
    if (!head) return;
    const name = selectedCompany ? escapeHtml(selectedCompany.name) : 'Select a company';
    let badge = '';
    if (editingOrderId) {
        const o = orders.find(x => x.id === editingOrderId);
        const po = o && o.poNumber ? escapeHtml(o.poNumber) : `Order #${editingOrderId}`;
        const changed = orderSignatureForSave() !== lastSavedSignature;
        badge = changed
            ? `<span class="save-state unsaved">${po} · unsaved changes</span>`
            : `<span class="save-state saved">${po} · saved${lastSavedAt ? ' ' + lastSavedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</span>`;
    } else if (currentOrder.items.length) {
        badge = `<span class="save-state unsaved">New order · not saved yet</span>`;
    }
    head.innerHTML = `<span>${name}</span>${badge}`;
    const cnt = document.getElementById('compact-order-count');
    if (cnt) cnt.textContent = currentOrder.items.length ? ` (${currentOrder.items.length})` : '';
    const sb = document.getElementById('save-btn'), sc = document.getElementById('save-close-btn');
    if (sb && sc) sc.disabled = sb.disabled;
}

(function () {
    // Remember when the last save happened
    const baseSave = saveOrder;
    saveOrder = async function (closeAfter = false) {
        await baseSave.call(this, closeAfter);
        if (editingOrderId) { lastSavedAt = new Date(); updateBuilderStatus(); }
    };
    // Opening a saved order: it starts out "saved"
    const baseLoad2 = loadOrder;
    loadOrder = function () {
        baseLoad2.apply(this, arguments);
        if (document.body.classList.contains('compact')) setCompactView('orders');
        lastSavedSignature = orderSignatureForSave();
        lastSavedAt = null;
        updateBuilderStatus();
    };
    // Every change to the order refreshes the status
    const baseTotals = updateOrderTotals;
    updateOrderTotals = function () { baseTotals.apply(this, arguments); updateBuilderStatus(); };
    const baseClear = clearOrder;
    clearOrder = function () { baseClear.apply(this, arguments); lastSavedSignature = ''; lastSavedAt = null; updateBuilderStatus(); };
})();
document.addEventListener('input', e => {
    if (e.target && (e.target.id === 'order-date' || e.target.id === 'order-po')) updateBuilderStatus();
});

// =====================================================================
// ==================== RESIZABLE INVENTORY / ORDERS SPLIT =============
// =====================================================================
const SPLIT_KEY = 'lcSplit';
const SPLIT_DEFAULT = 52;          // % of the width for Inventory
function applySplit(pct) {
    const v = Math.min(70, Math.max(30, pct));
    document.documentElement.style.setProperty('--inv-col', v + 'fr');
    document.documentElement.style.setProperty('--ord-col', (100 - v) + 'fr');
    return v;
}
(function initSplitter() {
    let saved = SPLIT_DEFAULT;
    try { saved = parseFloat(localStorage.getItem(SPLIT_KEY)) || SPLIT_DEFAULT; } catch (e) { /* ignore */ }
    applySplit(saved);
    const handle = document.getElementById('panel-splitter');
    if (!handle) return;
    let dragging = false;
    const onMove = e => {
        if (!dragging) return;
        const main = document.querySelector('main');
        const r = main.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(main).paddingLeft) || 0;
        const inner = r.width - pad * 2;
        const pct = ((e.clientX - r.left - pad) / inner) * 100;
        saved = applySplit(pct);
    };
    const stop = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('resizing');
        try { localStorage.setItem(SPLIT_KEY, String(saved)); } catch (e) { /* ignore */ }
    };
    handle.addEventListener('pointerdown', e => {
        dragging = true;
        document.body.classList.add('resizing');
        handle.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('dblclick', () => {
        saved = applySplit(SPLIT_DEFAULT);
        try { localStorage.setItem(SPLIT_KEY, String(saved)); } catch (e) { /* ignore */ }
        showToast('Panel sizes reset', 'info');
    });
})();


// =====================================================================
// ==================== SCREEN LAYOUT: Desktop / r1 compact ============
// =====================================================================
// "auto" uses the compact layout on very small screens (the r1 is 240 x 282).
const COMPACT_MAX_WIDTH = 480;
let compactView = 'inventory';

function isCompactWanted() {
    const mode = getSettings().layout || 'auto';
    if (mode === 'compact') return true;
    if (mode === 'desktop') return false;
    return window.innerWidth <= COMPACT_MAX_WIDTH;
}

function applyLayout() {
    const on = isCompactWanted();
    document.body.classList.toggle('compact', on);
    if (on) setCompactView(compactView);
}

function setCompactView(view) {
    compactView = view;
    document.body.dataset.view = view;
    document.querySelectorAll('#compact-nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    const main = document.querySelector('main');
    if (main) main.scrollTop = 0;
    window.scrollTo(0, 0);
}

window.addEventListener('resize', () => {
    if ((getSettings().layout || 'auto') === 'auto') applyLayout();
});

// In compact mode, choosing a company or reordering brings you to the right section
(function () {
    const baseReorderAdd = addReorderToOrder;
    addReorderToOrder = function () {
        baseReorderAdd.apply(this, arguments);
        if (document.body.classList.contains('compact')) setCompactView('orders');
    };
})();

// ---- rabbit r1 hardware: scroll wheel and side button ----
// The r1 sends these as window events: 'scrollUp', 'scrollDown', 'sideClick'.
function r1ScrollTarget() {
    const open = document.querySelector('.modal.show .modal-content');
    return open || null;
}
function r1Scroll(amount) {
    // In compact mode the content area (main) scrolls, not the page
    const box = r1ScrollTarget() || (document.body.classList.contains('compact') ? document.querySelector('main') : null);
    // Each wheel click moves straight away, so quick turns add up
    if (box) box.scrollTop += amount;
    else window.scrollBy(0, amount);
}
window.addEventListener('scrollUp', () => r1Scroll(-70));
window.addEventListener('scrollDown', () => r1Scroll(70));
let lastSideClick = 0;
window.addEventListener('sideClick', () => {
    // One press can arrive twice ~50 ms apart: ignore the repeat
    const now = Date.now();
    if (now - lastSideClick < 350) return;
    if (now - voiceLastPressEnd < 900) return;   // this was the end of a hold-to-talk
    lastSideClick = now;
    // Side button = the main button of whatever window is open
    const open = document.querySelector('.modal.show');
    if (!open) return;
    if (open.id === 'item-modal') { addItemToOrder('add'); return; }
    const primary = open.querySelector('.modal-footer .btn-add');
    if (primary) primary.click();
});

applyLayout();


// =====================================================================
// ==================== SORT THE ORDER'S LINES =========================
// =====================================================================
// Click a column heading in the Order Builder: first click sorts A→Z / low→high,
// second click reverses it. The new order is kept when you save, and it's the
// order the lines print in on the PO.
let orderSort = { key: null, dir: 1 };

function sortOrderItems(key) {
    if (!currentOrder.items.length) return;
    orderSort = { key, dir: orderSort.key === key ? -orderSort.dir : 1 };
    const num = k => ['qty', 'cost', 'lineTotal'].includes(k);
    const text = v => String(v == null ? '' : v).trim();
    currentOrder.items.sort((a, b) => {
        let r;
        if (num(key)) r = (Number(a[key]) || 0) - (Number(b[key]) || 0);
        else r = text(a[key]).localeCompare(text(b[key]), undefined, { numeric: true, sensitivity: 'base' });
        if (r === 0) r = text(a.description).localeCompare(text(b.description), undefined, { numeric: true, sensitivity: 'base' });
        return r * orderSort.dir;
    });
    renderOrderItems();
    updateOrderTotals();          // also marks a saved order as "unsaved changes"
}

function updateOrderSortArrows() {
    document.querySelectorAll('#builder-content th.sortable').forEach(th => {
        const on = th.dataset.sort === orderSort.key;
        th.classList.toggle('sorted', on);
        th.dataset.arrow = on ? (orderSort.dir === 1 ? '▲' : '▼') : '';
    });
}

(function () {
    const baseRender = renderOrderItems;
    renderOrderItems = function () { baseRender.apply(this, arguments); updateOrderSortArrows(); };
    // A new or different order starts unsorted
    const baseClear = clearOrder;
    clearOrder = function () { orderSort = { key: null, dir: 1 }; baseClear.apply(this, arguments); };
    const baseLoad = loadOrder;
    loadOrder = function () { orderSort = { key: null, dir: 1 }; baseLoad.apply(this, arguments); };
})();


// =====================================================================
// ==================== STRETCHABLE INVENTORY LIST =====================
// =====================================================================
// Drag the bar under the item list to make it taller or shorter. The height is
// remembered. Double-click the bar to go back to the normal size.
const INV_HEIGHT_KEY = 'lcInvHeight';
(function initInventoryResizer() {
    const bar = document.getElementById('inv-resizer');
    const box = document.querySelector('#inventory-panel .scrollable-table');
    if (!bar || !box) return;
    const setH = px => {
        const h = Math.max(200, Math.round(px));
        document.documentElement.style.setProperty('--inv-table-h', h + 'px');
        return h;
    };
    // Starting height: the list ends just above the bottom of the window, so the bar is always visible
    let userHeight = 0;
    try { userHeight = parseInt(localStorage.getItem(INV_HEIGHT_KEY)) || 0; } catch (e) { /* ignore */ }
    const fitToWindow = () => {
        if (userHeight || document.body.classList.contains('compact')) return;
        const top = box.getBoundingClientRect().top + window.scrollY;
        const room = window.innerHeight - top - bar.offsetHeight - 40;
        setH(Math.max(300, room));
    };
    if (userHeight) setH(userHeight); else fitToWindow();
    window.addEventListener('resize', fitToWindow);
    window.addEventListener('load', fitToWindow);
    // Re-fit whenever something above the list changes size (company list, invoice alerts, ...)
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => fitToWindow());
        ['companies-panel', 'invoice-alerts'].forEach(id => { const el = document.getElementById(id); if (el) ro.observe(el); });
        const hdr = document.querySelector('header'); if (hdr) ro.observe(hdr);
    }
    setTimeout(fitToWindow, 1500);

    let startY = 0, startH = 0, dragging = false, current = 0;
    bar.addEventListener('pointerdown', e => {
        dragging = true;
        startY = e.clientY;
        // start from the list's real height (it may be shorter than the limit when few items match)
        startH = Math.max(box.getBoundingClientRect().height, box.scrollHeight > box.clientHeight ? box.clientHeight : 0);
        current = startH;
        document.body.classList.add('resizing-v');
        bar.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    bar.addEventListener('pointermove', e => {
        if (!dragging) return;
        current = setH(startH + (e.clientY - startY));
        // keep the bar under the mouse when dragging past the bottom of the window
        if (e.clientY > window.innerHeight - 30) window.scrollBy(0, 20);
    });
    const stop = () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('resizing-v');
        userHeight = current;
        try { localStorage.setItem(INV_HEIGHT_KEY, String(current)); } catch (e) { /* ignore */ }
    };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
    bar.addEventListener('dblclick', () => {
        userHeight = 0;
        try { localStorage.removeItem(INV_HEIGHT_KEY); } catch (e) { /* ignore */ }
        fitToWindow();
        showToast('Item list back to its normal size', 'info');
    });
})();


// =====================================================================
// ==================== SPEECH TO TEXT FOR SEARCH ======================
// =====================================================================
// rabbit r1: HOLD the side button, say what you're looking for, let go.
//   The words go into the Search box and the item list is searched.
//   If you're typing in another text box (PO number, notes...), the words go there instead.
// Desktop (Chrome / Edge): click the microphone in the Search box, speak, and it searches.
// The r1 part follows the same steps as the r1 voice code in the other program:
//   longPressStart -> CreationVoiceHandler 'start', longPressEnd -> 'stop',
//   and the words arrive in window.onPluginMessage as type 'sttEnded' with a transcript.
let voiceLastPressEnd = 0;

(function () {
    const search = document.getElementById('search');
    const mic = document.getElementById('search-mic');
    const status = document.getElementById('voice-status');
    if (!search) return;

    const hasR1Voice = () => typeof CreationVoiceHandler !== 'undefined';
    const WebSpeech = window.SpeechRecognition || window.webkitSpeechRecognition;

    // ---------- shared ----------
    let target = null;          // the text box the words will go into
    let waiting = false;        // listening, or waiting for the words to come back
    let giveUpTimer = null;
    let otherHandler = null;    // any onPluginMessage handler installed by something else

    function showStatus(text, kind = 'listening') {
        if (!status) return;
        status.textContent = text;
        status.className = 'voice-status show ' + kind;
    }
    function hideStatus(delay = 0) {
        if (!status) return;
        setTimeout(() => { if (!waiting) status.className = 'voice-status'; }, delay);
    }
    function setMicState(on) { if (mic) mic.classList.toggle('listening', on); }

    // A plain text box the user is typing in right now (not numbers or dates)
    function focusedTextBox() {
        const el = document.activeElement;
        if (!el || el === search) return null;
        const tag = (el.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA') return el;
        if (tag === 'INPUT' && ['text', 'search', 'email', 'tel', ''].includes((el.type || '').toLowerCase())) return el;
        return null;
    }

    function chooseTarget() {
        return focusedTextBox() || search;
    }

    function putWords(words) {
        let text = String(words || '').trim();
        if (!text) { showStatus("Didn't catch that. Try again.", 'error'); waiting = false; setMicState(false); hideStatus(2500); return; }
        const field = target && document.body.contains(target) ? target : search;
        target = null;
        waiting = false;
        clearTimeout(giveUpTimer);
        setMicState(false);

        if (field === search) {
            // Search: replace what was there, drop the period speech adds at the end
            text = text.replace(/[.,!?;:]+$/, '');
            if (document.body.classList.contains('compact')) setCompactView('inventory');
            search.value = text;
            filterItems(true);
            showStatus('Searching: "' + text + '"', 'done');
            hideStatus(2200);
        } else {
            // Any other text box: type the words where the cursor is
            const start = field.selectionStart != null ? field.selectionStart : field.value.length;
            const end = field.selectionEnd != null ? field.selectionEnd : field.value.length;
            if (field.tagName !== 'TEXTAREA') text = text.replace(/[.,!?;:]+$/, '');
            field.value = field.value.slice(0, start) + text + field.value.slice(end);
            try { field.setSelectionRange(start + text.length, start + text.length); } catch (e) { /* ignore */ }
            field.dispatchEvent(new Event('input', { bubbles: true }));
            showStatus('Typed: "' + text + '"', 'done');
            hideStatus(2200);
        }
    }

    function startWaitingForWords() {
        clearTimeout(giveUpTimer);
        giveUpTimer = setTimeout(() => {
            if (!waiting) return;
            waiting = false;
            setMicState(false);
            showStatus("Didn't hear anything. Try again.", 'error');
            hideStatus(2500);
        }, 12000);
    }

    // ---------- rabbit r1 ----------
    function r1Send(cmd) {
        if (!hasR1Voice()) return false;
        try { CreationVoiceHandler.postMessage(cmd); return true; } catch (e) { return false; }
    }

    function handlePluginMessage(data) {
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (e) { data = { message: data }; }
        }
        if (!data) return;
        // The words can be at the top level or inside data.data (sometimes as text)
        let type = data.type;
        let transcript = data.transcript;
        if (!transcript && data.data) {
            let inner = data.data;
            if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch (e) { inner = null; } }
            if (inner && typeof inner === 'object') {
                if (inner.transcript) transcript = inner.transcript;
                if (!type && inner.type) type = inner.type;
            }
        }
        if (type === 'sttEnded' && waiting) putWords(transcript);
    }

    function combinedHandler(data) {
        try { handlePluginMessage(data); } catch (e) { console.warn('Voice error', e); }
        if (otherHandler) { try { otherHandler(data); } catch (e) { /* ignore */ } }
    }
    function ensureHandler() {
        const current = window.onPluginMessage;
        if (current === combinedHandler) return;
        otherHandler = typeof current === 'function' ? current : null;
        window.onPluginMessage = combinedHandler;
    }
    ensureHandler();

    function r1Start() {
        ensureHandler();
        // A pop-up window is open and nothing in it is being typed in: don't search behind it
        if (document.querySelector('.modal.show') && !focusedTextBox()) {
            showStatus('Close this window to search by voice', 'error');
            hideStatus(2500);
            return false;
        }
        target = chooseTarget();
        if (!r1Send('start')) return false;
        waiting = true;
        setMicState(true);
        showStatus(target === search ? 'Listening… say what to search for' : 'Listening…');
        return true;
    }
    function r1Stop() {
        if (!waiting) return;
        r1Send('stop');
        showStatus('Getting your words…', 'working');
        startWaitingForWords();
    }

    window.addEventListener('longPressStart', () => { r1Start(); });
    window.addEventListener('longPressEnd', () => { voiceLastPressEnd = Date.now(); r1Stop(); });

    // ---------- desktop browsers (Chrome / Edge) ----------
    let rec = null;
    function desktopStart() {
        if (!WebSpeech) return;
        if (rec) { try { rec.stop(); } catch (e) { /* ignore */ } return; }   // second click = stop
        target = search;
        rec = new WebSpeech();
        rec.lang = navigator.language || 'en-US';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        waiting = true;
        setMicState(true);
        showStatus('Listening… say what to search for');
        rec.onresult = e => {
            const words = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : '';
            putWords(words);
        };
        rec.onerror = e => {
            waiting = false; setMicState(false);
            const msg = e.error === 'not-allowed' || e.error === 'service-not-allowed'
                ? 'Microphone blocked. Allow it in the browser (address bar).'
                : e.error === 'no-speech' ? "Didn't hear anything. Try again." : 'Voice search stopped (' + e.error + ')';
            showStatus(msg, 'error');
            hideStatus(3500);
        };
        rec.onend = () => {
            rec = null;
            if (waiting) { waiting = false; setMicState(false); hideStatus(0); }
        };
        try { rec.start(); } catch (e) { rec = null; waiting = false; setMicState(false); }
    }

    // ---------- microphone button ----------
    // r1: tap to start, tap again to stop (same as holding the side button)
    // Desktop: click to talk; it stops by itself when you finish speaking
    if (mic) {
        if (!hasR1Voice() && !WebSpeech) {
            mic.classList.add('hidden');            // this browser can't do speech to text
        }
        mic.addEventListener('click', e => {
            e.preventDefault();
            if (hasR1Voice()) {
                if (waiting) r1Stop(); else { target = search; if (r1Start()) target = search; }
            } else {
                desktopStart();
            }
        });
    }
})();


// Search ignores upper/lower case, accents, apostrophes and other punctuation,
// so "rubies" finds "Rubie's", "spider man" finds "Spider-Man", "pinata" finds "Piñata".
function normalizeForSearch(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // é -> e, ñ -> n
        .replace(/['\u2019`]/g, '')                           // Rubie's -> rubies
        .replace(/[^a-z0-9#]+/g, ' ')                          // dashes, slashes, dots -> space
        .trim();
}
// Cached per item so searching 65,000 items stays fast
const searchTextCache = new WeakMap();
function searchTextFor(item) {
    const src = (item.sku || '') + ' ' + (item.supplier || '') + ' ' + (item.description || '');
    const c = searchTextCache.get(item);
    if (c && c.src === src) return c.norm;
    const norm = ' ' + normalizeForSearch(src) + ' ';
    searchTextCache.set(item, { src, norm });
    return norm;
}


// =====================================================================
// ==================== r1: SCROLL TABLES SIDEWAYS =====================
// =====================================================================
// The r1 screen is 240 px wide, so the Items table is wider than the screen.
// Swipe left/right on any table to move sideways (up/down still scrolls the page),
// or use the arrow buttons above the Items list. The description stays in place.
function scrollInventorySideways(dir) {
    const box = document.querySelector('#inventory-panel .scrollable-table');
    if (box) box.scrollLeft += dir * Math.max(80, box.clientWidth * 0.6);
}

(function () {
    let box = null, startX = 0, startY = 0, startLeft = 0, mode = null, pid = null;

    document.addEventListener('pointerdown', e => {
        if (!document.body.classList.contains('compact')) return;
        const t = e.target.closest && e.target.closest('.scrollable-table');
        if (!t || t.scrollWidth <= t.clientWidth + 2) return;      // nothing to scroll sideways
        if (e.target.closest('input, select, textarea, button')) return;
        box = t; startX = e.clientX; startY = e.clientY; startLeft = t.scrollLeft; mode = null; pid = e.pointerId;
    }, true);

    document.addEventListener('pointermove', e => {
        if (!box || e.pointerId !== pid) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!mode) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            mode = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';        // decide once per swipe
            if (mode === 'y') { box = null; return; }                // let the page scroll up/down
            try { box.setPointerCapture(pid); } catch (err) { /* ignore */ }   // keep following the finger
            const sel = window.getSelection && window.getSelection(); if (sel) sel.removeAllRanges();
        }
        box.scrollLeft = startLeft - dx;
        e.preventDefault();
    }, { capture: true, passive: false });

    const end = e => {
        if (!box || (e && e.pointerId !== pid)) return;
        if (mode === 'x') {
            // a swipe is not a tap: don't open the item under the finger
            const stopClick = ev => { ev.stopPropagation(); ev.preventDefault(); };
            document.addEventListener('click', stopClick, { capture: true, once: true });
            setTimeout(() => document.removeEventListener('click', stopClick, true), 400);
        }
        box = null; mode = null; pid = null;
    };
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
})();
