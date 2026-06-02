const { Core } = require('@adobe/aio-sdk');

let cachedToken = null;
let cachedExpiryMs = 0;

async function getImsAccessToken(params) {
    if (cachedToken && Date.now() < cachedExpiryMs - 60_000) {
        return cachedToken;
    }

    const tokenUrl = params.IMS_TOKEN_URL || 'https://ims-na1.adobelogin.com/ims/token/v2';

    const rawScopes = params.IMS_OAUTH_S2S_SCOPES || '';
    const scope = rawScopes.startsWith('[')
        ? JSON.parse(rawScopes).filter(Boolean).join(',')
        : rawScopes;

    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: String(params.IMS_OAUTH_S2S_CLIENT_ID || ''),
        client_secret: String(params.IMS_OAUTH_S2S_CLIENT_SECRET || ''),
        scope,
    });

    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });

    const data = await res.json();
    cachedToken = data.access_token;
    cachedExpiryMs = Date.now() + (data.expires_in || 3600) * 1000;
    return cachedToken;
}

async function fetchProductFromCommerce(sku, params) {
    const baseUrl = String(params.COMMERCE_API_BASE_URL).replace(/\/$/, '');
    const accessToken = await getImsAccessToken(params);

    const url = `${baseUrl}/V1/products/${encodeURIComponent(sku)}`;

    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'x-api-key': params.IMS_OAUTH_S2S_CLIENT_ID,
            'x-gw-ims-org-id': params.IMS_OAUTH_S2S_ORG_ID,
            'Content-Type': 'application/json',
        },
    });

    if (!res.ok) {
        throw new Error(`Commerce API error: ${res.status}`);
    }

    return res.json();
}

function evaluateBadges(product) {
    const badges = [];

    // Sale badge — final price lower than regular price
    const finalPrice = product.price;
    const regularPrice = product.custom_attributes
        ?.find((a) => a.attribute_code === 'special_price')?.value;

    if (regularPrice && parseFloat(finalPrice) < parseFloat(regularPrice)) {
        badges.push({ id: 'sale', label: 'Sale', modifier: 'sale' });
    }

    // New badge — driven by is_new custom attribute
    const isNew = product.custom_attributes
        ?.find((a) => a.attribute_code === 'is_new')?.value;

    if (isNew === '1') {
        badges.push({ id: 'new', label: 'New', modifier: 'new' });
    }

    return badges;
}

async function main(params) {
    const logger = Core.Logger('product-badge-state', {
        level: params.LOG_LEVEL || 'info',
    });

    try {
        const { sku } = params;

        if (!sku) {
            return {
                statusCode: 400,
                body: { error: 'Missing required parameter: sku' },
            };
        }

        if (!params.COMMERCE_API_BASE_URL) {
            return {
                statusCode: 400,
                body: { error: 'Missing COMMERCE_API_BASE_URL' },
            };
        }

        logger.info(`Evaluating badges for SKU: ${sku}`);

        const product = await fetchProductFromCommerce(sku, params);
        const badges = evaluateBadges(product);

        logger.info(`Badges resolved for SKU ${sku}: ${JSON.stringify(badges)}`);

        return {
            statusCode: 200,
            body: {
                sku,
                badges,
                evaluatedAt: new Date().toISOString(),
            },
        };
    } catch (error) {
        logger.error('Action failed:', error.message);
        return {
            statusCode: 500,
            body: { error: 'Internal server error', detail: error.message },
        };
    }
}

module.exports = { main };
