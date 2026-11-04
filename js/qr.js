export function drawQR(canvas, text) {
    const lib = window.QRCodeGen;
    if (!lib) throw new Error('qr-unavailable');
    let qr = null;
    for (let v = 1; v <= 40 && !qr; v++) {
        try { const q = new lib.QRCode(v, lib.ECC.L); q.addData(text); q.make(); qr = q; } catch (e) { qr = null; }
    }
    if (!qr) throw new Error('qr-too-big');
    const n = qr.getModuleCount();
    const quiet = 4;
    const scale = Math.max(3, Math.floor(480 / (n + quiet * 2)));
    const size = (n + quiet * 2) * scale;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
    }
    return n;
}

export function canScan() {
    return typeof window.BarcodeDetector === 'function' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export async function startScan(video, onCode, onError) {
    let stopped = false;
    let stream = null;
    const stop = () => {
        stopped = true;
        if (stream) stream.getTracks().forEach((t) => t.stop());
        stream = null;
        video.srcObject = null;
    };
    try {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) { stop(); return stop; }
        video.srcObject = stream;
        await video.play();
        const tick = async () => {
            if (stopped) return;
            try {
                const found = await detector.detect(video);
                if (found && found.length && found[0].rawValue) { stop(); onCode(found[0].rawValue); return; }
            } catch (e) { /* image pas prête */ }
            setTimeout(tick, 250);
        };
        tick();
    } catch (e) {
        stop();
        if (onError) onError(e);
    }
    return stop;
}
