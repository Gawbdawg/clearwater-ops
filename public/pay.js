const invoiceId = window.location.pathname.split('/').filter(Boolean).pop();
const params = new URLSearchParams(window.location.search);
const card = document.getElementById('payCard');

async function load() {
  try {
    const res = await fetch(`/api/pay/${invoiceId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Invoice not found');
    render(data);
  } catch (e) {
    card.innerHTML = `<h1>Invoice not found</h1><p class="portal-sub">${e.message}</p>`;
  }
}

function render(invoice) {
  const amount = Number(invoice.amount).toFixed(2);

  if (invoice.status === 'paid' || params.get('paid') === '1') {
    card.innerHTML = `
      <h1>Thanks!</h1>
      <p class="portal-sub">This invoice for $${amount} has been paid. We appreciate your business.</p>
    `;
    return;
  }

  if (!invoice.stripeConfigured) {
    card.innerHTML = `
      <h1>Invoice #${invoice.id}</h1>
      <p class="portal-sub">Amount due: $${amount}${invoice.dueDate ? ` (due ${invoice.dueDate})` : ''}</p>
      <p class="portal-sub">Online payment isn't turned on yet — please contact Clear Water Spa Service to arrange payment.</p>
    `;
    return;
  }

  card.innerHTML = `
    <h1>Invoice #${invoice.id}</h1>
    <p class="portal-sub">Amount due: $${amount}${invoice.dueDate ? ` (due ${invoice.dueDate})` : ''}</p>
    <div id="payError" class="portal-error hidden"></div>
    <button class="btn primary" id="payBtn">Pay $${amount} now</button>
  `;

  document.getElementById('payBtn').addEventListener('click', async () => {
    const btn = document.getElementById('payBtn');
    const errEl = document.getElementById('payError');
    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Redirecting to secure checkout…';
    try {
      const res = await fetch(`/api/pay/${invoiceId}/checkout`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start checkout');
      window.location.href = data.url;
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = `Pay $${amount} now`;
    }
  });
}

load();
