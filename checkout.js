const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Basic email validation
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Basic string sanitiser — strips HTML tags
function sanitise(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim().slice(0, 200);
}

// POST /checkout/create-session
router.post('/create-session', async (req, res) => {
  const { plan, customerEmail, vehicleData, standalone } = req.body;

  // Validate plan
  const allowedPlans = ['starter', 'annual_renewal', 'extra_sticker', 'replacement'];
  if (!plan || !allowedPlans.includes(plan)) {
    return res.status(400).json({ error: `Invalid plan` });
  }

  // Validate email
  if (!customerEmail || !isValidEmail(customerEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  // Sanitise vehicle data fields
  let cleanVehicleData = null;
  if (vehicleData && typeof vehicleData === 'object') {
    cleanVehicleData = {
      firstName:    sanitise(vehicleData.firstName),
      lastName:     sanitise(vehicleData.lastName),
      stickerName:  sanitise(vehicleData.stickerName).slice(0, 12),
      mobile:       sanitise(vehicleData.mobile),
      streetNo:     sanitise(vehicleData.addrStreetNo),
      streetName:   sanitise(vehicleData.addrStreetName),
      suburb:       sanitise(vehicleData.addrSuburb),
      addrState:    sanitise(vehicleData.addrState),
      postcode:     sanitise(vehicleData.addrPostcode),
      plate:        sanitise(vehicleData.plate),
      state:        sanitise(vehicleData.state),
      regoDay:      sanitise(String(vehicleData.regoExpiry || '').split('/')[0] || ''),
      regoMonth:    sanitise(String(vehicleData.regoExpiry || '').split('/')[1] || ''),
      regoPeriod:   vehicleData.regoPeriod ? parseInt(vehicleData.regoPeriod) : 12,
      licDay:       sanitise(String(vehicleData.licExpiry  || '').split('/')[0] || ''),
      licMonth:     sanitise(String(vehicleData.licExpiry  || '').split('/')[1] || ''),
      licYear:      sanitise(String(vehicleData.licExpiry  || '').split('/')[2] || ''),
    };
  }

  const priceMap = {
    starter:        process.env.PRICE_STARTER,        // legacy combined price - no longer used for new sessions
    annual_renewal: process.env.PRICE_ANNUAL_RENEWAL,
    extra_sticker:  process.env.PRICE_EXTRA_STICKER,
    replacement:    process.env.PRICE_REPLACEMENT
  };

  // Build line items based on plan
  let lineItems;

  if (plan === 'starter') {
    // First-time signup: base subscription + postage & handling as separate line items
    lineItems = [
      { price: process.env.PRICE_STARTER_BASE, quantity: 1 },
      { price: process.env.PRICE_POSTAGE, quantity: 1 }
    ];
  } else if (plan === 'extra_sticker' && standalone) {
    // Adding an extra vehicle later from the account page — sticker is shipped
    // separately, so postage & handling applies
    lineItems = [
      { price: process.env.PRICE_EXTRA_STICKER, quantity: 1 },
      { price: process.env.PRICE_POSTAGE, quantity: 1 }
    ];
  } else {
    // extra_sticker bundled at signup (no extra postage), annual_renewal, replacement
    lineItems = [{ price: priceMap[plan], quantity: 1 }];
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: customerEmail,
      // Create a Stripe Customer and save their card for future off-session
      // charges — needed for licence renewal stickers (P&H) and annual
      // subscription renewals.
      customer_creation: 'always',
      payment_intent_data: {
        setup_future_usage: 'off_session'
      },
      line_items: lineItems,
      metadata: {
        plan,
        ...(cleanVehicleData ? { vehicleData: JSON.stringify(cleanVehicleData) } : {}),
        ...(req.body.extras?.length ? { extras: JSON.stringify(req.body.extras.map(e => ({
          firstName:  sanitise(e.firstName  || ''),
          mobile:     sanitise(e.mobile     || ''),
          plate:      sanitise(e.plate      || ''),
          state:      sanitise(e.state      || ''),
          regoDay:    sanitise(String(e.regoExpiryDay   || '')),
          regoMonth:  sanitise(String(e.regoExpiryMonth || '')),
          licDay:     sanitise(String(e.licExpiryDay    || '')),
          licMonth:   sanitise(String(e.licExpiryMonth  || '')),
          licYear:    sanitise(String(e.licExpiryYear   || '')),
        }))) } : {})
      },
      success_url: 'https://regomate.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://regomate.com/cancelled'
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe session error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

module.exports = router;
