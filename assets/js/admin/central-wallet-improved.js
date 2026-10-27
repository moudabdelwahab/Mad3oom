import { supabase } from '/api-config.js';
import { platformAuthority } from '/assets/js/platform-authority.js';

/**
 * Enhanced Central Wallet Service
 * Handles all operations for the central wallet (can_manage_central_wallet: support@ or the platform owner in context)
 * With proper error handling and transaction verification
 */

export const CentralWalletService = {
    /**
     * Get central wallet balance and stats
     */
    async getWalletData() {
        try {
            const { data, error } = await supabase
                .from('central_wallet')
                .select('*')
                .single();
            
            if (error) throw error;
            return data;
        } catch (error) {
            console.error('Error fetching wallet data:', error);
            throw error;
        }
    },

    /**
     * Transfer points from central wallet to a user
     * With verification that points were actually transferred
     */
    async transferPoints(targetEmail, amount) {
        try {
            // Validate inputs
            if (!targetEmail || !targetEmail.trim()) {
                throw new Error('بريد العميل مطلوب');
            }
            if (!amount || parseInt(amount) <= 0) {
                throw new Error('يجب أن يكون عدد النقاط أكبر من صفر');
            }

            // Get wallet balance before transfer
            const walletBefore = await this.getWalletData();
            
            // Call the RPC function
            const { data, error } = await supabase.rpc('transfer_points_from_central', {
                target_user_email: targetEmail,
                amount_to_transfer: parseInt(amount)
            });

            if (error) {
                console.error('Transfer RPC error:', error);
                throw new Error(error.message || 'فشل التحويل');
            }

            if (!data || !data.success) {
                throw new Error(data?.message || 'فشل التحويل');
            }

            // Verify the transfer was successful by checking wallet balance
            await new Promise(resolve => setTimeout(resolve, 500)); // Wait for DB update
            const walletAfter = await this.getWalletData();
            
            const balanceDecreased = walletBefore.balance - walletAfter.balance === parseInt(amount);
            if (!balanceDecreased) {
                console.warn('Balance verification failed - expected decrease:', parseInt(amount), 'actual:', walletBefore.balance - walletAfter.balance);
            }

            return {
                success: true,
                message: 'تم تحويل النقاط بنجاح',
                data: data
            };
        } catch (error) {
            console.error('Transfer error:', error);
            throw error;
        }
    },

    /**
     * Manage user points (add, deduct, freeze, unfreeze)
     * With verification of the operation
     */
    async manageUserPoints(targetEmail, amount, actionType) {
        try {
            // Validate inputs
            if (!targetEmail || !targetEmail.trim()) {
                throw new Error('بريد العميل مطلوب');
            }
            if (actionType !== 'freeze' && actionType !== 'unfreeze') {
                if (!amount || parseInt(amount) < 0) {
                    throw new Error('يجب أن يكون عدد النقاط صحيحاً');
                }
            }

            const { data, error } = await supabase.rpc('manage_user_points', {
                target_user_email: targetEmail,
                amount_change: parseInt(amount || 0),
                action_type: actionType
            });

            if (error) {
                console.error('Manage points RPC error:', error);
                throw new Error(error.message || 'فشلت العملية');
            }

            if (!data || !data.success) {
                throw new Error(data?.message || 'فشلت العملية');
            }

            return {
                success: true,
                message: data.message || 'تمت العملية بنجاح',
                data: data
            };
        } catch (error) {
            console.error('Manage points error:', error);
            throw error;
        }
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
 * Enhanced UI Component for Central Wallet
 * With professional modal design and improved UX
 */
export class CentralWalletUI {
    constructor() {
        this.container = null;
        this.modal = null;
        this.isSupport = false;
        this.currentUser = null;
        this.isLoading = false;
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
            
            // من يدير المحفظة المركزية تقرّره القاعدة (can_manage_central_wallet، 115): حساب support@ كما كان،
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
        walletBtn.setAttribute('aria-label', 'المحفظة المركزية');
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
            <div id="centralWalletModal" class="admin-modal">
                <div class="modal-content">
                    <div class="modal-header">
                        <h2>المحفظة المركزية</h2>
                        <button class="close-modal" aria-label="إغلاق">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div id="modalMessage" class="modal-message"></div>
                        
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
                                <label for="targetUserEmail">بريد العميل الإلكتروني</label>
                                <input type="email" id="targetUserEmail" placeholder="example@mail.com" required>
                            </div>
                            <div class="form-group">
                                <label for="pointsAmount">عدد النقاط</label>
                                <input type="number" id="pointsAmount" placeholder="0" min="0" required>
                            </div>
                            <div class="action-buttons">
                                <button id="btnTransfer" class="btn-primary" title="تحويل النقاط من المحفظة المركزية">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M12 5v14M5 12l7-7 7 7"/>
                                    </svg>
                                    تحويل من المركزية
                                </button>
                                <button id="btnAdd" class="btn-success" title="إضافة نقاط للعميل">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <circle cx="12" cy="12" r="10"/>
                                        <path d="M12 8v8M8 12h8"/>
                                    </svg>
                                    إضافة رصيد
                                </button>
                                <button id="btnDeduct" class="btn-danger" title="خصم نقاط من العميل">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <circle cx="12" cy="12" r="10"/>
                                        <path d="M8 12h8"/>
                                    </svg>
                                    خصم رصيد
                                </button>
                                <button id="btnFreeze" class="btn-warning" title="تجميد رصيد العميل">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                                    </svg>
                                    تجميد الرصيد
                                </button>
                                <button id="btnUnfreeze" class="btn-info" title="إلغاء تجميد رصيد العميل">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                                    </svg>
                                    إلغاء التجميد
                                </button>
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

        walletBtn.onclick = (e) => {
            e.preventDefault();
            this.openModal();
        };

        closeBtn.onclick = () => {
            this.closeModal();
        };

        // Close modal when clicking outside
        this.modal.onclick = (event) => {
            if (event.target === this.modal) {
                this.closeModal();
            }
        };

        // Close modal with Escape key
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.modal.classList.contains('show')) {
                this.closeModal();
            }
        });

        // Action Buttons
        const getInputs = () => ({
            email: document.getElementById('targetUserEmail')?.value?.trim() || '',
            amount: document.getElementById('pointsAmount')?.value?.trim() || ''
        });

        const handleAction = async (action, type = null) => {
            const { email, amount } = getInputs();
            
            try {
                this.setLoading(true);
                this.clearMessage();

                if (!email) {
                    this.showMessage('يرجى إدخال بريد العميل', 'error');
                    return;
                }
                
                let result;
                if (action === 'transfer') {
                    if (!amount || parseInt(amount) <= 0) {
                        this.showMessage('يرجى إدخال عدد نقاط صحيح', 'error');
                        return;
                    }
                    result = await CentralWalletService.transferPoints(email, amount);
                } else {
                    result = await CentralWalletService.manageUserPoints(email, amount, type);
                }

                if (result?.success) {
                    this.showMessage(result.message, 'success');
                    this.updateBalance();
                    // Clear inputs after successful operation
                    document.getElementById('targetUserEmail').value = '';
                    document.getElementById('pointsAmount').value = '';
                } else {
                    this.showMessage(result?.message || 'حدث خطأ غير معروف', 'error');
                }
            } catch (error) {
                console.error('Wallet action error:', error);
                this.showMessage(error.message || 'حدث خطأ أثناء تنفيذ العملية', 'error');
            } finally {
                this.setLoading(false);
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

    openModal() {
        if (!this.modal) return;
        this.modal.classList.add('show');
        this.updateBalance();
        document.body.style.overflow = 'hidden';
    }

    closeModal() {
        if (!this.modal) return;
        this.modal.classList.remove('show');
        document.body.style.overflow = 'auto';
    }

    setLoading(isLoading) {
        this.isLoading = isLoading;
        if (!this.modal) return;
        
        const buttons = this.modal.querySelectorAll('.action-buttons button');
        buttons.forEach(btn => {
            btn.disabled = isLoading;
            btn.style.opacity = isLoading ? '0.6' : '1';
        });
    }

    showMessage(message, type = 'info') {
        const messageEl = document.getElementById('modalMessage');
        if (!messageEl) return;
        
        messageEl.textContent = message;
        messageEl.className = `modal-message show ${type}`;
        
        // Auto-hide success messages after 3 seconds
        if (type === 'success') {
            setTimeout(() => {
                messageEl.classList.remove('show');
            }, 3000);
        }
    }

    clearMessage() {
        const messageEl = document.getElementById('modalMessage');
        if (!messageEl) return;
        messageEl.classList.remove('show');
    }

    async updateBalance() {
        if (!this.isSupport) return;
        
        try {
            const data = await CentralWalletService.getWalletData();
            this.updateUI(data);
        } catch (error) {
            console.error('Error fetching wallet data:', error);
            this.showMessage('فشل تحديث بيانات المحفظة', 'error');
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
        if (this.modal && this.modal.classList.contains('show')) {
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
