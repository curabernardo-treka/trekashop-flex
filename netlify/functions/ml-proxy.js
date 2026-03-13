// netlify/functions/ml-proxy.js
// Optimizado: batch calls — de 108 llamadas a ~8

const ML_ACCOUNTS = {
  trekashop:    { userId:'152867840',   clientId:'8787677066125951', clientSecret:'mBP2zPeVX5U7TkTITHeeYmheQrRAabAS', refreshToken:'TG-69ab8c2187025f0001d9649d-152867840' },
  treka1:       { userId:'168993406',   clientId:'8787677066125951', clientSecret:'mBP2zPeVX5U7TkTITHeeYmheQrRAabAS', refreshToken:'TG-69ab886f8ecb4d0001f50b8f-168993406' },
  factormarket: { userId:'3102232605',  clientId:'8787677066125951', clientSecret:'mBP2zPeVX5U7TkTITHeeYmheQrRAabAS', refreshToken:'TG-69ab899ad5e297000125240e-3102232605' },
};

async function getAccessToken(acc) {
  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: acc.clientId,
      client_secret: acc.clientSecret,
      refresh_token: acc.refreshToken,
    })
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(`Token error: ${data.message}`);
  return data.access_token;
}

async function getPendingShipments(accountName, acc) {
  const token = await getAccessToken(acc);
  const shipments = [];
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString().split('.')[0] + '.000Z';
  let offset = 0;

  while (true) {
    // 1 call per page of 50 orders
    const r = await fetch(
      `https://api.mercadolibre.com/orders/search?seller=${acc.userId}&order.status=paid&order.date_created.from=${weekAgo}&limit=50&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) break;
    const data = await r.json();
    const orders = data.results || [];

    // Collect shipping IDs
    const shippingIds = [...new Set(
      orders.map(o => String(o.shipping?.id || '')).filter(id => id && id !== '0')
    )];

    // Batch fetch shipments — 1 call per 20 IDs instead of 1 per shipment
    const shipMap = {};
    const BATCH = 20;
    for (let i = 0; i < shippingIds.length; i += BATCH) {
      const batch = shippingIds.slice(i, i + BATCH);
      try {
        const sr = await fetch(
          `https://api.mercadolibre.com/shipments?ids=${batch.join(',')}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (sr.ok) {
          const arr = await sr.json();
          for (const item of (Array.isArray(arr) ? arr : [])) {
            const ship = item.body || item;
            if (ship?.id) shipMap[String(ship.id)] = ship;
          }
        }
      } catch (e) { console.warn('Batch error:', e.message); }
    }

    // Build results from order + shipment data
    for (const ord of orders) {
      const shipId = String(ord.shipping?.id || '');
      if (!shipId || shipId === '0') continue;
      const ship = shipMap[shipId];
      if (ship && !['ready_to_ship', 'handling'].includes(ship.status)) continue;

      const ra = ship?.receiver_address || {};
      const d = ord.date_created ? new Date(ord.date_created) : null;
      shipments.push({
        shipmentId: shipId,
        account: accountName,
        orderId: String(ord.id),
        recipientName: ra.receiver_name || ord.buyer?.nickname || '—',
        address: [ra.street_name, ra.street_number, ra.city?.name].filter(Boolean).join(', ') || '—',
        orderTime: d ? d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) : null,
        orderDate: d ? d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : null,
        status: ship?.status || 'unknown',
      });
    }

    if (orders.length < 50) break;
    offset += 50;
  }

  return shipments;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const results = await Promise.allSettled(
      Object.entries(ML_ACCOUNTS).map(([name, acc]) => getPendingShipments(name, acc))
    );
    const allShipments = [];
    const errors = [];
    results.forEach((r, i) => {
      const name = Object.keys(ML_ACCOUNTS)[i];
      if (r.status === 'fulfilled') allShipments.push(...r.value);
      else errors.push({ account: name, error: r.reason?.message });
    });
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        shipments: allShipments, errors, total: allShipments.length,
        counts: {
          trekashop: allShipments.filter(s => s.account === 'trekashop').length,
          treka1: allShipments.filter(s => s.account === 'treka1').length,
          factormarket: allShipments.filter(s => s.account === 'factormarket').length,
        }
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
