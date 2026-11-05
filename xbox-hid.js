// Xbox Bluetooth firmware exposes this 16-byte HID report even when the
// browser's native Gamepad API does not enumerate the controller.
(() => {
    const VENDOR_MICROSOFT = 0x045e;
    const PRODUCT_XBOX_SERIES = 0x0b13;
    const nativeGetGamepads = navigator.getGamepads?.bind(navigator);
    let device;
    let activeKey;
    let activeSnapshot;
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
        if (candidate.vendorId !== VENDOR_MICROSOFT || candidate.productId !== PRODUCT_XBOX_SERIES) return false;
        return candidate.collections.some(collection =>
            collection.usagePage === 1 && collection.usage === 5 &&
            collection.inputReports.some(report => report.reportId === 1 &&
                report.items.map(item => `${item.reportSize}:${item.reportCount}`).join(',') ===
                '16:2,16:2,10:1,6:1,10:1,6:1,4:1,4:1,1:15,1:1,1:1,7:1' &&
                validUsages(report.items)));
    }

    // Layout and mappings match Chromium's MapperXboxSeriesXBluetooth:
    // https://chromium.googlesource.com/chromium/src/+/refs/tags/129.0.6651.2/device/gamepad/gamepad_standard_mappings_mac.mm
    function validUsages(items) {
        const fields = [
            [0, 0, 65535, [0x10030, 0x10031]],
            [1, 0, 65535, [0x10032, 0x10035]],
            [2, 0, 1023, [0x200c5]],
            [4, 0, 1023, [0x200c4]],
            [6, 1, 8, [0x10039]],
            [10, 0, 1, [0xc00b2]],
        ];
        return fields.every(([index, min, max, usages]) => {
            const item = items[index];
            return !item.isConstant && !item.isArray && !item.isRange &&
                item.logicalMinimum === min && item.logicalMaximum === max &&
                JSON.stringify(item.usages) === JSON.stringify(usages);
        }) && [3, 5, 7, 9, 11].every(index => items[index].isConstant) &&
            !items[8].isConstant && !items[8].isArray && items[8].isRange &&
            items[8].logicalMinimum === 0 && items[8].logicalMaximum === 1 &&
            items[8].usageMinimum === 0x90001 && items[8].usageMaximum === 0x9000f;
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

    function source() {
        if (pad.connected) return pad;
        try { return Array.from(nativeGetGamepads?.() || []).find(gamepad => gamepad?.connected); }
        catch { return null; }
    }

    function snapshot(gamepad, active = true) {
        return {
            id: gamepad.id, index: 0, mapping: gamepad.mapping, connected: true,
            timestamp: gamepad.timestamp,
            axes: active ? gamepad.axes : neutral.axes,
            buttons: active ? gamepad.buttons : neutral.buttons,
        };
    }

    // Both input paths expose one controller in slot zero. Native browser slot
    // numbers never leak into the engine, including during HID/native handoffs.
    Object.defineProperty(navigator, 'getGamepads', {
        configurable: true,
        value: () => {
            const gamepad = source();
            return gamepad ? [snapshot(gamepad, document.hasFocus() && !document.hidden)] : [];
        },
    });

    function notify(type, gamepad) {
        const event = new Event(type);
        event.gamepad = gamepad;
        event.vcController = true;
        window.dispatchEvent(event);
    }

    function updateConnection() {
        const gamepad = source();
        const key = gamepad === pad ? 'hid' : gamepad && `native:${gamepad.index}:${gamepad.id}`;
        if (key !== activeKey) {
            const previous = activeSnapshot;
            activeKey = key;
            activeSnapshot = gamepad && snapshot(gamepad);
            if (previous) notify('gamepaddisconnected', { ...previous, connected: false });
            if (activeSnapshot) notify('gamepadconnected', activeSnapshot);
        }
        updateStatus();
    }
    for (const type of ['gamepadconnected', 'gamepaddisconnected']) {
        window.addEventListener(type, event => {
            if (event.vcController || event.gamepad?.emulation) return;
            event.stopImmediatePropagation();
            updateConnection();
        }, true);
    }

    async function open(candidate) {
        if (!supportsReport(candidate)) throw new Error('Unsupported Xbox HID report format');
        if (!candidate.opened) await candidate.open();
        device?.removeEventListener('inputreport', readReport);
        device = candidate;
        device.addEventListener('inputreport', readReport);
        pad.connected = true;
        updateConnection();
    }

    window.vcXboxHid = {
        async connect(requestAccess = false) {
            if (pad.connected || !navigator.hid) { updateStatus(); return; }
            try {
                if (source()) { updateStatus(); return; }
                const granted = await navigator.hid.getDevices();
                let candidate = granted.find(supportsReport);
                if (!candidate && requestAccess) {
                    [candidate] = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR_MICROSOFT, productId: PRODUCT_XBOX_SERIES }] });
                }
                if (candidate) await open(candidate);
                else updateStatus();
            } catch (error) {
                console.warn('Xbox HID connection:', error.message);
                setStatus('controller.failed', { message: error.message });
            }
        },
    };
    navigator.hid?.addEventListener('disconnect', event => {
        if (event.device !== device) return;
        pad.connected = false;
        pad.axes.fill(0);
        pad.buttons.forEach((_, index) => setButton(index, 0));
        updateConnection();
    });
    navigator.hid?.addEventListener('connect', event => {
        if (!device || !supportsReport(event.device)) return;
        open(event.device).catch(error => console.warn('Xbox HID reconnect:', error.message));
    });
    const button = document.getElementById('connect-controller');
    const status = document.getElementById('controller-status');
    function setStatus(key, options) {
        if (status) window.vcI18n.setText(status, key, options);
    }
    function updateStatus() {
        const gamepad = source();
        if (button) button.disabled = !!gamepad;
        setStatus(gamepad ? 'controller.connected' : navigator.hid ? 'controller.idle' : 'controller.nativeOnly', { name: gamepad?.id });
    }
    if (button) {
        button.hidden = !navigator.hid;
        button.addEventListener('click', async () => {
            button.disabled = true;
            setStatus('controller.connecting');
            try { await window.vcXboxHid.connect(true); }
            finally { button.disabled = !!source(); }
        });
    }
    updateStatus();
})();
