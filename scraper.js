const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'offers.json');
const ENV_FILE = path.join(__dirname, '.env');

// Load .env file manually
function loadEnv() {
    try {
        const content = fs.readFileSync(ENV_FILE, 'utf8');
        content.split('\n').forEach(line => {
            const match = line.match(/^([^#=]+)=(.*)$/);
            if (match) {
                process.env[match[1].trim()] = match[2].trim();
            }
        });
    } catch (e) {}
}
loadEnv();

// Telegram config from environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function fetchHtml(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function parseOffers(html) {
    const offers = [];
    
    // Look for offer cards in the HTML - updated regex for the site structure
    const offerRegex = /<a[^>]*href="([^"]*\/(?:oferty|offers)\/[^"]*)"[^>]*>[\s\S]*?<h[1-6][^>]*>([^<]*)<\/h[1-6]>[\s\S]*?<\/a>/gi;
    let match;
    
    while ((match = offerRegex.exec(html)) !== null) {
        const url = match[1].startsWith('http') ? match[1] : `https://praktyki.lodz.pl${match[1]}`;
        const title = match[2].trim();
        if (title && url && title.length > 3) {
            offers.push({ id: url, title, url });
        }
    }
    
    // Alternative: look for JSON data in script tags
    const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/);
    if (jsonMatch) {
        try {
            const data = JSON.parse(jsonMatch[1]);
            if (data.offers || data.practices) {
                const items = data.offers || data.practices || [];
                items.forEach(item => {
                    offers.push({
                        id: item.id || item.slug,
                        title: item.title || item.name,
                        url: `https://praktyki.lodz.pl/en/oferty/${item.slug || item.id}`
                    });
                });
            }
        } catch (e) {}
    }
    
    // Remove duplicates by URL
    const unique = {};
    offers.forEach(o => unique[o.url] = o);
    return Object.values(unique);
}

async function fetchAllOffers() {
    const allOffers = [];
    let page = 1;
    const maxPages = 20; // Safety limit
    
    while (page <= maxPages) {
        const url = `https://praktyki.lodz.pl/en/offers?practiceType=holiday_internship&page=${page}`;
        console.log(`Fetching page ${page}...`);
        
        try {
            const html = await fetchHtml(url);
            const offers = parseOffers(html);
            
            if (offers.length === 0) {
                console.log(`No more offers on page ${page}, stopping.`);
                break;
            }
            
            console.log(`Found ${offers.length} offers on page ${page}`);
            allOffers.push(...offers);
            
            // Check if there's a next page by looking for pagination
            const hasNextPage = html.includes(`page=${page + 1}`) || 
                               html.includes(`"page":${page + 1}`) ||
                               html.includes(`> ${page + 1} <`) ||
                               html.includes(`>${page + 1}<`);
            
            if (!hasNextPage && page > 1) {
                console.log('No next page found, stopping.');
                break;
            }
            
            page++;
        } catch (err) {
            console.error(`Error fetching page ${page}:`, err.message);
            break;
        }
    }
    
    // Remove duplicates across all pages
    const unique = {};
    allOffers.forEach(o => unique[o.url] = o);
    return Object.values(unique);
}

function loadPreviousOffers() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) {}
    return [];
}

function saveOffers(offers) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(offers, null, 2));
}

function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('Telegram not configured:', message);
        return Promise.resolve();
    }
    
    const text = encodeURIComponent(message);
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${text}&parse_mode=HTML`;
    
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log('Telegram response:', data);
                resolve(data);
            });
        }).on('error', reject);
    });
}

async function main() {
    console.log('Fetching all offers...');
    const currentOffers = await fetchAllOffers();
    console.log(`Total unique offers: ${currentOffers.length}`);
    
    const previousOffers = loadPreviousOffers();
    const previousUrls = new Set(previousOffers.map(o => o.url));
    
    const newOffers = currentOffers.filter(o => !previousUrls.has(o.url));
    
    if (newOffers.length > 0) {
        console.log(`New offers found: ${newOffers.length}`);
        for (const offer of newOffers) {
            const message = `<b>New Internship Offer!</b>\n\n${offer.title}\n\n<a href="${offer.url}">View Offer</a>`;
            await sendTelegram(message);
        }
    } else {
        console.log('No new offers');
    }
    
    saveOffers(currentOffers);
    
    // Update index.html with latest status
    const statusHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Praktyki Scraper Status</title>
    <meta http-equiv="refresh" content="300">
</head>
<body>
    <h1>Praktyki Scraper Status</h1>
    <p>Last check: ${new Date().toISOString()}</p>
    <p>Total offers: ${currentOffers.length}</p>
    <p>New offers (last check): ${newOffers.length}</p>
    <h2>Current Offers:</h2>
    <ul>
        ${currentOffers.map(o => `<li><a href="${o.url}">${o.title}</a></li>`).join('')}
    </ul>
</body>
</html>`;
    fs.writeFileSync(path.join(__dirname, 'index.html'), statusHtml);
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
