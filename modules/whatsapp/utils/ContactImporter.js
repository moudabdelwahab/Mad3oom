/**
 * ContactImporter.js
 * نظام احترافي لاستيراد جهات الاتصال يدعم Excel, CSV, Google Sheets
 */

export class ContactImporter {
    constructor() {
        this.data = [];
        this.headers = [];
        this.phoneColumn = null;
        this.mapping = {};
        this.stats = {
            total: 0,
            valid: [],
            invalid: [],
            duplicates: []
        };
    }

    /**
     * قراءة ملف (Excel أو CSV)
     */
    async readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            const extension = file.name.split('.').pop().toLowerCase();

            reader.onload = (e) => {
                try {
                    const data = e.target.result;
                    let workbook;
                    
                    if (extension === 'csv') {
                        const content = new TextDecoder('utf-8').decode(data);
                        workbook = XLSX.read(content, { type: 'string' });
                    } else {
                        workbook = XLSX.read(data, { type: 'array' });
                    }

                    const firstSheetName = workbook.SheetNames[0];
                    const worksheet = workbook.Sheets[firstSheetName];
                    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

                    if (jsonData.length === 0) {
                        throw new Error('الملف فارغ');
                    }

                    this.headers = jsonData[0];
                    this.data = jsonData.slice(1).map(row => {
                        const obj = {};
                        this.headers.forEach((header, index) => {
                            obj[header] = row[index];
                        });
                        return obj;
                    });

                    this.autoDetectPhoneColumn();
                    resolve({
                        headers: this.headers,
                        data: this.data,
                        phoneColumn: this.phoneColumn
                    });
                } catch (error) {
                    reject(error);
                }
            };

            if (extension === 'csv') {
                reader.readAsArrayBuffer(file);
            } else {
                reader.readAsArrayBuffer(file);
            }
        });
    }

    /**
     * الاكتشاف التلقائي لعمود أرقام الهاتف
     */
    autoDetectPhoneColumn() {
        const phoneKeywords = ['phone', 'mobile', 'tel', 'هاتف', 'جوال', 'رقم', 'whatsapp'];
        
        // 1. البحث بواسطة اسم العمود
        for (let header of this.headers) {
            const h = String(header).toLowerCase();
            if (phoneKeywords.some(k => h.includes(k))) {
                this.phoneColumn = header;
                return;
            }
        }

        // 2. البحث بواسطة محتوى البيانات (أول 10 صفوف)
        for (let header of this.headers) {
            const samples = this.data.slice(0, 10).map(row => String(row[header]));
            const isPhone = samples.some(s => /^\+?\d{8,15}$/.test(s.replace(/[\s\-\(\)]/g, '')));
            if (isPhone) {
                this.phoneColumn = header;
                return;
            }
        }
    }

    /**
     * تنظيف وتوحيد تنسيق الرقم
     */
    normalizePhoneNumber(phone) {
        if (!phone) return null;
        // إزالة المسافات والأقواس والشرطات
        let cleaned = String(phone).replace(/[\s\-\(\)\+]/g, '');
        
        // إذا كان يبدأ بـ 00 حوله لـ + (التي حذفناها للتو)
        if (cleaned.startsWith('00')) {
            cleaned = cleaned.substring(2);
        }

        // إضافة رمز الدولة إذا كان مفقوداً (افتراضياً 966 للسعودية إذا كان يبدأ بـ 05 أو 5)
        if (cleaned.startsWith('05') && cleaned.length === 10) {
            cleaned = '966' + cleaned.substring(1);
        } else if (cleaned.startsWith('5') && cleaned.length === 9) {
            cleaned = '966' + cleaned;
        }

        return cleaned;
    }

    /**
     * التحقق من صحة البيانات ومعالجتها
     */
    process(phoneColumn, mapping = {}) {
        this.phoneColumn = phoneColumn;
        this.mapping = mapping;
        
        const seen = new Set();
        this.stats = {
            total: this.data.length,
            valid: [],
            invalid: [],
            duplicates: []
        };

        this.data.forEach((row, index) => {
            const rawPhone = row[phoneColumn];
            const cleanPhone = this.normalizePhoneNumber(rawPhone);
            
            // إنشاء كائن جهة الاتصال مع المتغيرات المربوطة
            const contact = {
                _raw: row,
                phone: cleanPhone,
                variables: {}
            };

            // ربط المتغيرات
            for (let [varName, colName] of Object.entries(mapping)) {
                contact.variables[varName] = row[colName] || '';
            }

            // التحقق
            if (!cleanPhone || cleanPhone.length < 8 || cleanPhone.length > 15 || !/^\d+$/.test(cleanPhone)) {
                this.stats.invalid.push({ index, row, reason: 'رقم غير صحيح' });
            } else if (seen.has(cleanPhone)) {
                this.stats.duplicates.push({ index, row, phone: cleanPhone });
            } else {
                seen.add(cleanPhone);
                this.stats.valid.push(contact);
            }
        });

        return this.stats;
    }

    /**
     * إنشاء تقرير HTML ملخص
     */
    generateSummaryHTML() {
        return `
            <div class="import-summary" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 15px;">
                <div style="padding: 10px; background: var(--bg-elevated); border-radius: 8px; text-align: center;">
                    <div style="font-size: 12px; color: var(--text-secondary);">صالح</div>
                    <div style="font-size: 18px; font-weight: 700; color: var(--status-success);">${this.stats.valid.length}</div>
                </div>
                <div style="padding: 10px; background: var(--bg-elevated); border-radius: 8px; text-align: center;">
                    <div style="font-size: 12px; color: var(--text-secondary);">مكرر</div>
                    <div style="font-size: 18px; font-weight: 700; color: var(--status-warning);">${this.stats.duplicates.length}</div>
                </div>
                <div style="padding: 10px; background: var(--bg-elevated); border-radius: 8px; text-align: center;">
                    <div style="font-size: 12px; color: var(--text-secondary);">غير صالح</div>
                    <div style="font-size: 18px; font-weight: 700; color: var(--status-error);">${this.stats.invalid.length}</div>
                </div>
            </div>
        `;
    }
}
