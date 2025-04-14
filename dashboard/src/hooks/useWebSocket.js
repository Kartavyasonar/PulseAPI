import { useState, useEffect, useRef, useCallback } from 'react';

export function useWebSocket(url) {
  const [status, setStatus] = useState('connecting');
  const [lastStats, setLastStats] = useState(null);
  const [recentRequests, setRecentRequests] = useState([]);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setStatus('connected');
    ws.onclose = () => {
      setStatus('disconnected');
      reconnectTimer.current = setTimeout(connect, 3000);
    };
    ws.onerror = () => setStatus('error');

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'stats') {
          setLastStats(msg.data);
        } else if (msg.type === 'request') {
          setRecentRequests((prev) => [msg.data, ...prev].slice(0, 50));
        }
      } catch {}
    };
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { status, lastStats, recentRequests };
}
