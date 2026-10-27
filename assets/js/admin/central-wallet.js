import { supabase } from '/api-config.js';
import { platformAuthority } from '/assets/js/platform-authority.js';

/**
 * Central Wallet Service
 * Handles all operations for the central wallet (can_manage_central_wallet: support@ or the platform owner in context)
 */

export const CentralWalletService = {
    /**
     * Get central wallet balance and stats
     */
    async getWalletData() {
        const { data, error } = await supabase
            .from('central_wallet')
            .select('*')
            .single();
        
        if (error) throw error;
        return data;
    },

    /**
     * Transfer points from central wallet to a user
     */
    async transferPoints(targetEmail, amount) {
        const { data, error } = await supabase.rpc('transfer_points_from_central', {
            target_user_email: targetEmail,
            amount_to_transfer: parseInt(amount)
        });

        if (error) throw error;
        return data;
    },

    /**
     * Manage user points (add, deduct, freeze, unfreeze)
     */
    async manageUserPoints(targetEmail, amount, actionType) {
        const { data, error } = await supabase.rpc('manage_user_points', {
            target_user_email: targetEmail,
            amount_change: parseInt(amount || 0),
            action_type: actionType
        });

        if (error) throw error;
        return data;
    },

    /**
     * Subscribe to real-time updates for the central wallet
     */
    subscribeToUpdates(callback) {
        return supabase
            .channel('central_wallet_changes')
            .on('postgres_changes', { 
                event: 'UPDATE', 
                schema: 'public', 
                table: 'central_wallet' 
            }, payload => {
                callback(payload.new);
            })
            .subscribe();
    }
};

/**
 * UI Component for Central Wallet
 */
export class CentralWalletUI {
    constructor() {
        this.container = null;
        this.modal = null;
        this.isSupport = false;
        this.currentUser = null;
    }

    async init() {
        try {
            const { data: { user }, error } = await supabase.auth.getUser();
            
            if (error) {
                console.error('Auth error:', error);
                return;
            }
            
            if (!user) {
                console.warn('No authenticated user found');
                return;
            }

            this.currentUser = user;
            
            // من يدير المحفظة المركزية تقرّره القاعدة (can_manage_central_wallet، 117): حساب support@ كما كان،
            // أو مالك المنصة في سياقه. نفس المُسنَد الذي يحرس central_wallet ودوال التحويل.
            const { canManageCentralWallet } = await platformAuthority();
            if (!canManageCentralWallet) {
                console.info('Central wallet is restricted to its managers (can_manage_central_wallet)');
                return;
            }

            this.isSupport = true;
            this.renderIcon();
            this.renderModal();
            this.setupEventListeners();
            this.updateBalance();
            
            // Real-time updates
            CentralWalletService.subscribeToUpdates((newData) => {
                this.updateUI(newData);
            });
        } catch (error) {
            console.error('Error initializing central wallet:', error);
        }
    }

    renderIcon() {
        if (!this.isSupport) return;
        
        const navActions = document.querySelector('.nav-actions');
        if (!navActions) {
            console.warn('nav-actions element not found');
            return;
        }

        const walletBtn = document.createElement('button');
        walletBtn.className = 'nav-btn central-wallet-btn';
        walletBtn.id = 'centralWalletBtn';
        walletBtn.title = 'المحفظة المركزية';
        walletBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"></path>
                <path d="M4 6v12c0 1.1.9 2 2 2h14v-4"></path>
                <path d="M18 12a2 2 0 0 0-2 2c0 1.1.9 2 2 2h4v-4h-4z"></path>
            </svg>
            <div class="wallet-tooltip" id="walletTooltip">
                <div class="tooltip-item">الرصيد المتاح: <span id="tooltipBalance">...</span></div>
                <div class="tooltip-item">الرصيد المحول: <span id="tooltipTransferred">...</span></div>
            </div>
        `;

        // Insert before notification button
        const notificationBtn = document.getElementById('notificationBtn');
        if (notificationBtn) {
            navActions.insertBefore(walletBtn, notificationBtn);
        } else {
            navActions.appendChild(walletBtn);
        }
    }

    renderModal() {
        if (!this.isSupport) return;
        
        const modalHtml = `
            <div id="centralWalletModal" class="admin-modal" style="display: none;">
                <div class="modal-content">
                    <div class="modal-header">
                        <h2>المحفظة المركزية</h2>
                        <button class="close-modal">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="wallet-stats-grid">
                            <div class="stat-card">
                                <span class="stat-label">الرصيد الحالي</span>
                                <span class="stat-value" id="modalBalance">0</span>
                            </div>
                            <div class="stat-card">
                                <span class="stat-label">إجمالي المحول</span>
                                <span class="stat-value" id="modalTransferred">0</span>
                            </div>
                        </div>

                        <div class="wallet-actions-form">
                            <div class="form-group">
                                <label>بريد العميل الإلكتروني</label>
                                <input type="email" id="targetUserEmail" placeholder="example@mail.com">
                            </div>
                            <div class="form-group">
                                <label>عدد النقاط</label>
                                <input type="number" id="pointsAmount" placeholder="0" min="0">
                            </div>
                            <div class="action-buttons">
                                <button id="btnTransfer" class="btn-primary">تحويل من المركزية</button>
                                <button id="btnAdd" class="btn-success">إضافة رصيد</button>
                                <button id="btnDeduct" class="btn-danger">خصم رصيد</button>
                                <button id="btnFreeze" class="btn-warning">تجميد رصيد</button>
                                <button id="btnUnfreeze" class="btn-info">إلغاء التجميد</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        this.modal = document.getElementById('centralWalletModal');
    }

    setupEventListeners() {
        if (!this.isSupport || !this.modal) return;
        
        const walletBtn = document.getElementById('centralWalletBtn');
        const closeBtn = this.modal.querySelector('.close-modal');

        if (!walletBtn || !closeBtn) {
            console.warn('Required modal elements not found');
            return;
        }

        walletBtn.onclick = () => {
            this.modal.style.display = 'flex';
            this.updateBalance();
        };

        closeBtn.onclick = () => {
            this.modal.style.display = 'none';
        };

        window.onclick = (event) => {
            if (event.target === this.modal) {
                this.modal.style.display = 'none';
            }
        };

        // Action Buttons
        const getInputs = () => ({
            email: document.getElementById('targetUserEmail')?.value || '',
            amount: document.getElementById('pointsAmount')?.value || ''
        });

        const handleAction = async (action, type = null) => {
            const { email, amount } = getInputs();
            if (!email || !email.trim()) return alert('يرجى إدخال بريد العميل');
            
            try {
                let result;
                if (action === 'transfer') {
                    if (!amount || parseInt(amount) <= 0) return alert('يرجى إدخال عدد نقاط صحيح');
                    result = await CentralWalletService.transferPoints(email, amount);
                } else {
                    result = await CentralWalletService.manageUserPoints(email, amount, type);
                }

                if (result?.success) {
                    alert(result.message);
                    this.updateBalance();
                    // Clear inputs
                    document.getElementById('targetUserEmail').value = '';
                    document.getElementById('pointsAmount').value = '';
                } else {
                    alert(result?.message || 'حدث خطأ غير معروف');
                }
            } catch (error) {
                console.error('Wallet action error:', error);
                alert('حدث خطأ أثناء تنفيذ العملية: ' + (error.message || 'خطأ غير معروف'));
            }
        };

        const btnTransfer = document.getElementById('btnTransfer');
        const btnAdd = document.getElementById('btnAdd');
        const btnDeduct = document.getElementById('btnDeduct');
        const btnFreeze = document.getElementById('btnFreeze');
        const btnUnfreeze = document.getElementById('btnUnfreeze');

        if (btnTransfer) btnTransfer.onclick = () => handleAction('transfer');
        if (btnAdd) btnAdd.onclick = () => handleAction('manage', 'add');
        if (btnDeduct) btnDeduct.onclick = () => handleAction('manage', 'deduct');
        if (btnFreeze) btnFreeze.onclick = () => handleAction('manage', 'freeze');
        if (btnUnfreeze) btnUnfreeze.onclick = () => handleAction('manage', 'unfreeze');
    }

    async updateBalance() {
        if (!this.isSupport) return;
        
        try {
            const data = await CentralWalletService.getWalletData();
            this.updateUI(data);
        } catch (error) {
            console.error('Error fetching wallet data:', error);
        }
    }

    updateUI(data) {
        if (!data) return;
        
        const format = (num) => {
            if (typeof num !== 'number') return '0';
            return new Intl.NumberFormat('ar-EG').format(num);
        };
        
        // Tooltip
        const tooltipBalance = document.getElementById('tooltipBalance');
        const tooltipTransferred = document.getElementById('tooltipTransferred');
        
        if (tooltipBalance) tooltipBalance.innerText = format(data.balance);
        if (tooltipTransferred) tooltipTransferred.innerText = format(data.total_transferred);
        
        // Modal
        if (this.modal && this.modal.style.display !== 'none') {
            const modalBalance = document.getElementById('modalBalance');
            const modalTransferred = document.getElementById('modalTransferred');
            
            if (modalBalance) modalBalance.innerText = format(data.balance);
            if (modalTransferred) modalTransferred.innerText = format(data.total_transferred);
        }
    }
}

// Initialize on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        const walletUI = new CentralWalletUI();
        walletUI.init();
    });
} else {
    // DOM is already loaded
    const walletUI = new CentralWalletUI();
    walletUI.init();
}
