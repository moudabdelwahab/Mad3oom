/**
 * UI Service for professional notifications and modals
 * This service provides a way to show toasts and custom modals
 */

export const ui = {
    /**
     * Show a professional toast notification
     * @param {string} message - The message to display
     * @param {string} type - 'success', 'error', 'info', 'warning'
     * @param {number} duration - Duration in ms
     */
    showToast(message, type = 'info', duration = 4000) {
        // Create container if it doesn't exist
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.style.cssText = `
                position: fixed;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 9999;
                display: flex;
                flex-direction: column;
                gap: 10px;
                pointer-events: none;
                width: 100%;
                max-width: 400px;
                padding: 0 20px;
            `;
            document.body.appendChild(container);
        }

        // Create toast element
        const toast = document.createElement('div');
        const colors = {
            success: { bg: '#2E8A3A', icon: '✓' },
            error: { bg: '#D9534F', icon: '✕' },
            info: { bg: '#0077CC', icon: 'ℹ' },
            warning: { bg: '#E0A800', icon: '⚠' }
        };
        const config = colors[type] || colors.info;

        toast.style.cssText = `
            background: ${config.bg};
            color: white;
            padding: 12px 20px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.2);
            display: flex;
            align-items: center;
            gap: 12px;
            font-weight: 500;
            font-size: 0.95rem;
            pointer-events: auto;
            animation: toastSlideIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
            direction: rtl;
        `;

        toast.innerHTML = `
            <span style="
                background: rgba(255,255,255,0.2);
                width: 24px;
                height: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                font-size: 0.8rem;
                flex-shrink: 0;
            ">${config.icon}</span>
            <span style="flex: 1;">${message}</span>
            <button style="
                background: none;
                border: none;
                color: white;
                cursor: pointer;
                font-size: 1.2rem;
                padding: 0;
                line-height: 1;
                opacity: 0.7;
            " onclick="this.parentElement.remove()">×</button>
        `;

        // Add animation styles if not present
        if (!document.getElementById('toast-animations')) {
            const style = document.createElement('style');
            style.id = 'toast-animations';
            style.textContent = `
                @keyframes toastSlideIn {
                    from { transform: translateY(-100px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
                @keyframes toastSlideOut {
                    from { transform: translateY(0); opacity: 1; }
                    to { transform: translateY(-20px); opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }

        container.appendChild(toast);

        // Auto remove
        setTimeout(() => {
            toast.style.animation = 'toastSlideOut 0.4s ease forwards';
            setTimeout(() => toast.remove(), 400);
        }, duration);
    },

    /**
     * Show a professional alert modal
     */
    showAlert(title, message, type = 'info') {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            backdrop-filter: blur(4px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            padding: 20px;
            direction: rtl;
        `;

        const modal = document.createElement('div');
        const colors = {
            success: '#2E8A3A',
            error: '#D9534F',
            info: '#0077CC',
            warning: '#E0A800'
        };
        const color = colors[type] || colors.info;

        modal.style.cssText = `
            background: var(--color-surface, white);
            width: 100%;
            max-width: 450px;
            border-radius: 20px;
            overflow: hidden;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
            animation: modalScaleIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        `;

        modal.innerHTML = `
            <div style="height: 6px; background: ${color};"></div>
            <div style="padding: 30px; text-align: center;">
                <div style="
                    width: 60px;
                    height: 60px;
                    background: ${color}15;
                    color: ${color};
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 2rem;
                    margin: 0 auto 20px;
                ">${type === 'success' ? '✓' : type === 'error' ? '✕' : '!'}</div>
                <h3 style="margin: 0 0 10px; font-size: 1.5rem; color: var(--color-text, #333);">${title}</h3>
                <p style="margin: 0 0 25px; color: var(--color-text-secondary, #666); line-height: 1.6;">${message}</p>
                <button id="modal-close-btn" style="
                    background: ${color};
                    color: white;
                    border: none;
                    padding: 12px 30px;
                    border-radius: 10px;
                    font-weight: 600;
                    cursor: pointer;
                    width: 100%;
                    font-size: 1rem;
                    transition: opacity 0.2s;
                ">حسناً</button>
            </div>
        `;

        if (!document.getElementById('modal-animations')) {
            const style = document.createElement('style');
            style.id = 'modal-animations';
            style.textContent = `
                @keyframes modalScaleIn {
                    from { transform: scale(0.9); opacity: 0; }
                    to { transform: scale(1); opacity: 1; }
                }
            `;
            document.head.appendChild(style);
        }

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const close = () => {
            overlay.style.opacity = '0';
            overlay.style.transition = 'opacity 0.2s';
            setTimeout(() => overlay.remove(), 200);
        };

        modal.querySelector('#modal-close-btn').onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };
    }
};
