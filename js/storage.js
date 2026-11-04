export const KEYS = {
    config: 'mellowConfig',
    history: 'mellowHistory',
    tutorial: 'mellowTutorialSeen',
    pin: 'mellowPin'
};

export const rawGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
export const rawSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* plein ou bloqué */ } };
export const rawDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } };
export const jsonGet = (k, fallback) => {
    try { const v = rawGet(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
};
export const jsonSet = (k, v) => rawSet(k, JSON.stringify(v));
