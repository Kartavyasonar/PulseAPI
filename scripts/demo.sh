#!/bin/bash
# PulseAPI Demo — ~90 second walkthrough of all features
GATEWAY="http://localhost:3000"
ADMIN_KEY="admin-secret-key"

echo "⚡ PulseAPI Demo"
echo "================"

echo -e "\n1️⃣  Health check..."
curl -s "$GATEWAY/health" | python3 -m json.tool 2>/dev/null || curl -s "$GATEWAY/health"

echo -e "\n2️⃣  Generate test JWT..."
TOKEN=$(curl -s -X POST "$GATEWAY/admin/token" -H "X-Api-Key: $ADMIN_KEY" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "Token: ${TOKEN:0:60}..."

echo -e "\n3️⃣  Baseline traffic (50 req to /api/)..."
for i in $(seq 1 50); do curl -s -o /dev/null "$GATEWAY/api/users?id=$i" & done; wait
echo "Done"

echo -e "\n4️⃣  Analytics..."
curl -s -H "X-Api-Key: $ADMIN_KEY" "$GATEWAY/admin/analytics" | python3 -c "
import sys,json; s=json.load(sys.stdin)['summary']
print(f'  total={s[\"total_requests\"]}  p50={s[\"p50\"]}ms  p95={s[\"p95\"]}ms  p99={s[\"p99\"]}ms')
" 2>/dev/null

echo -e "\n5️⃣  Rate limiting (/public/ = 10 req/s)..."
for i in $(seq 1 20); do STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY/public/x"); echo -n "$STATUS "; done
echo -e "\n429s = token bucket working ✅"

echo -e "\n6️⃣  JWT auth on /secure/..."
echo -n "  no token:   "; curl -s -o /dev/null -w "%{http_code}" "$GATEWAY/secure/data"; echo
echo -n "  with JWT:   "; curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$GATEWAY/secure/data"; echo

echo -e "\n7️⃣  Hot route add (no restart)..."
curl -s -X POST "$GATEWAY/admin/routes" \
  -H "X-Api-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"id":"demo","pathPrefix":"/demo","upstreams":[{"url":"http://upstream3:4003","weight":1}]}' \
  | python3 -c "import sys,json; print(' ', json.load(sys.stdin).get('message',''))" 2>/dev/null
echo -n "  new route:  "; curl -s -o /dev/null -w "%{http_code}" "$GATEWAY/demo/hello"; echo " ✅"

echo -e "\n8️⃣  Circuit breaker states..."
curl -s -H "X-Api-Key: $ADMIN_KEY" "$GATEWAY/admin/circuit-breakers" | python3 -c "
import sys,json
for url,state in json.load(sys.stdin)['states'].items(): print(f'  {url}: {state}')
" 2>/dev/null

echo -e "\n==============="
echo "✅  Demo complete!"
echo "🎛️  Dashboard: http://localhost:5173"
