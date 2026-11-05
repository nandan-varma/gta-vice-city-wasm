// Xbox Bluetooth firmware exposes this 16-byte HID report even when the
// browser's native Gamepad API does not enumerate the controller.
(() => {
    const VENDOR_MICROSOFT = 0x045e;
    const nativeGetGamepads = navigator.getGamepads?.bind(navigator);
    let device;
    const makePad = () => ({
        id: 'Xbox Wireless Controller (Xinput STANDARD GAMEPAD)',
        index: 0,
        mapping: 'standard',
        connected: false,
        timestamp: 0,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })),
    });
    const pad = makePad();
    const neutral = makePad();

    function supportsReport(candidate) {
        if (candidate.vendorId !== VENDOR_MICROSOFT) return false;
        return candidate.collections.some(collection =>
            collection.usagePage === 1 && collection.usage === 5 &&
            collection.inputReports.some(report => report.reportId === 1 &&
                report.items.map(item => `${item.reportSize}:${item.reportCount}`).join(',') ===
                '16:2,16:2,10:1,6:1,10:1,6:1,4:1,4:1,1:15,1:1,1:1,7:1'));
    }

    function setButton(index, value) {
        Object.assign(pad.buttons[index], { value, pressed: value > 0.5, touched: value > 0 });
    }

    function readReport({ reportId, data }) {
        if (reportId !== 1 || data.byteLength !== 16) return;
        for (let i = 0; i < 4; i++) {
            const value = data.getUint16(i * 2, true) - 32768;
            pad.axes[i] = value / (value < 0 ? 32768 : 32767);
        }
        const buttons = data.getUint16(13, true);
        // HID usages have gaps; these are the W3C standard button positions.
        [0, 1, 3, 4, 6, 7].forEach((bit, index) => setButton(index, (buttons >> bit) & 1));
        setButton(6, (data.getUint16(8, true) & 1023) / 1023);
        setButton(7, (data.getUint16(10, true) & 1023) / 1023);
        [10, 11, 13, 14].forEach((bit, index) => setButton(index + 8, (buttons >> bit) & 1));
        const hat = data.getUint8(12) & 15;
        setButton(12, Number(hat === 1 || hat === 2 || hat === 8));
        setButton(13, Number(hat >= 4 && hat <= 6));
        setButton(14, Number(hat >= 6 && hat <= 8));
        setButton(15, Number(hat >= 2 && hat <= 4));
        setButton(16, (buttons >> 12) & 1);
        pad.timestamp = performance.now();
    }

    function notify(type) {
        const event = new Event(type);
        event.gamepad = pad;
        window.dispatchEvent(event);
    }

    async function open(candidate) {
        if (!supportsReport(candidate)) throw new Error('Unsupported Xbox HID report format');
        if (!candidate.opened) await candidate.open();
        device?.removeEventListener('inputreport', readReport);
        device = candidate;
        device.addEventListener('inputreport', readReport);
        pad.connected = true;
        // The engine reads the first gamepad. Keep HID input in slot zero and
        // do not deliver both native and HID copies of the same controller.
        Object.defineProperty(navigator, 'getGamepads', {
            configurable: true,
            value: () => {
                if (!pad.connected) return [null];
                if (document.hasFocus() && !document.hidden) return [pad];
                neutral.connected = true;
                neutral.timestamp = performance.now();
                return [neutral];
            },
        });
        notify('gamepadconnected');
    }

    window.vcXboxHid = {
        async connect() {
            if (pad.connected || !navigator.hid) return;
            try {
                if (Array.from(nativeGetGamepads?.() || []).some(gamepad => gamepad?.connected)) return;
                const granted = await navigator.hid.getDevices();
                let candidate = granted.find(supportsReport);
                if (!candidate) {
                    [candidate] = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR_MICROSOFT }] });
                }
                if (candidate) await open(candidate);
            } catch (error) {
                console.warn('Xbox HID connection:', error.message);
            }
        },
    };
    navigator.hid?.addEventListener('disconnect', event => {
        if (event.device !== device) return;
        pad.connected = false;
        pad.axes.fill(0);
        pad.buttons.forEach((_, index) => setButton(index, 0));
        notify('gamepaddisconnected');
    });
    navigator.hid?.addEventListener('connect', event => {
        if (!device || event.device.vendorId !== device.vendorId || event.device.productId !== device.productId) return;
        open(event.device).catch(error => console.warn('Xbox HID reconnect:', error.message));
    });
})();
