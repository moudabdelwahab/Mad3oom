/**
 * ملف التحقق من صحة البيانات للمصادقة
 * يحتوي على جميع دوال التحقق من البريد والهاتف وكلمة المرور
 */

import { VALIDATION } from './constants.js';

/**
 * التحقق من أن البريد الإلكتروني ليس من دومين شائع
 * @param {string} email - البريد الإلكتروني
 * @returns {boolean} - true إذا كان الدومين خاصاً (ليس شائعاً)
 */
export function isCorporateEmail(email) {
    if (!email || !email.includes('@')) return false;
    const domain = email.split('@')[1].toLowerCase();
    return !VALIDATION.COMMON_DOMAINS.includes(domain);
}

/**
 * التحقق من صحة البريد الإلكتروني
 * @param {string} email - البريد الإلكتروني
 * @returns {boolean} - true إذا كان البريد صحيحاً
 */
export function validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
}

/**
 * التحقق من صحة رقم الهاتف
 * يدعم الأرقام المحلية والدولية
 * @param {string} phone - رقم الهاتف
 * @returns {boolean} - true إذا كان الرقم صحيحاً
 */
export function validatePhone(phone) {
    // إزالة المسافات والشرطات والأقواس
    const cleanPhone = phone.replace(/[\s\-()]/g, '');
    
    // التحقق من أن الرقم يحتوي على 10-15 رقم
    const phoneRegex = /^(\+\d{1,3})?[0-9]{9,14}$/;
    return phoneRegex.test(cleanPhone);
}

/**
 * التحقق من قوة كلمة المرور
 * المتطلبات:
 * - 8 أحرف على الأقل
 * - حرف كبير واحد على الأقل
 * - حرف صغير واحد على الأقل
 * - رقم واحد على الأقل
 * @param {string} password - كلمة المرور
 * @returns {Object} - { isValid: boolean, errors: string[] }
 */
export function validatePassword(password) {
    const errors = [];
    
    if (password.length < 8) {
        errors.push('كلمة المرور يجب أن تكون 8 أحرف على الأقل');
    }
    
    if (!/[A-Z]/.test(password)) {
        errors.push('كلمة المرور يجب أن تحتوي على حرف كبير واحد على الأقل');
    }
    
    if (!/[a-z]/.test(password)) {
        errors.push('كلمة المرور يجب أن تحتوي على حرف صغير واحد على الأقل');
    }
    
    if (!/[0-9]/.test(password)) {
        errors.push('كلمة المرور يجب أن تحتوي على رقم واحد على الأقل');
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * التحقق من صحة بيانات الفرد
 * @param {Object} data - بيانات الفرد
 * @returns {Object} - { isValid: boolean, errors: string[] }
 */
export function validateIndividualData(data) {
    const errors = [];
    
    // التحقق من الاسم الأول
    if (!data.firstName || data.firstName.trim().length < 2) {
        errors.push('الاسم الأول يجب أن يكون على الأقل حرفين');
    }
    
    // التحقق من الاسم الأخير
    if (!data.lastName || data.lastName.trim().length < 2) {
        errors.push('الاسم الأخير يجب أن يكون على الأقل حرفين');
    }
    
    // التحقق من البريد الإلكتروني
    if (!validateEmail(data.email)) {
        errors.push('البريد الإلكتروني غير صحيح');
    }
    
    // التحقق من رقم الهاتف
    if (!validatePhone(data.phone)) {
        errors.push('رقم الهاتف غير صحيح');
    }
    
    // التحقق من كلمة المرور
    const passwordValidation = validatePassword(data.password);
    if (!passwordValidation.isValid) {
        errors.push(...passwordValidation.errors);
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * التحقق من صحة بيانات الشركة
 * @param {Object} data - بيانات الشركة
 * @returns {Object} - { isValid: boolean, errors: string[] }
 */
export function validateCompanyData(data) {
    const errors = [];
    
    // التحقق من اسم الشركة
    if (!data.companyName || data.companyName.trim().length < 2) {
        errors.push('اسم الشركة يجب أن يكون على الأقل حرفين');
    }
    
    // التحقق من رقم السجل التجاري
    if (!data.commercialRegistrationNumber || data.commercialRegistrationNumber.trim().length < 5) {
        errors.push('رقم السجل التجاري غير صحيح');
    }
    
    // التحقق من البريد الإلكتروني للشركة
    if (!validateEmail(data.companyEmail)) {
        errors.push('البريد الإلكتروني للشركة غير صحيح');
    } else if (!isCorporateEmail(data.companyEmail)) {
        errors.push('يجب استخدام بريد إلكتروني رسمي للشركة (لا يقبل gmail, yahoo, إلخ)');
    }
    
    // التحقق من رقم هاتف الشركة
    if (!validatePhone(data.companyPhone)) {
        errors.push('رقم هاتف الشركة غير صحيح');
    }
    
    // التحقق من البريد الإلكتروني الشخصي
    if (!validateEmail(data.email)) {
        errors.push('البريد الإلكتروني الشخصي غير صحيح');
    }
    
    // التحقق من رقم الهاتف الشخصي
    if (!validatePhone(data.phone)) {
        errors.push('رقم الهاتف الشخصي غير صحيح');
    }
    
    // التحقق من كلمة المرور
    const passwordValidation = validatePassword(data.password);
    if (!passwordValidation.isValid) {
        errors.push(...passwordValidation.errors);
    }
    
    // التحقق من العنوان
    if (!data.address || data.address.trim().length < 5) {
        errors.push('العنوان غير صحيح');
    }
    
    // التحقق من المدينة
    if (!data.city || data.city.trim().length < 2) {
        errors.push('المدينة غير صحيحة');
    }
    
    // التحقق من الدولة
    if (!data.country || data.country.trim().length < 2) {
        errors.push('الدولة غير صحيحة');
    }
    
    // التحقق من الموقع الإلكتروني (اختياري)
    if (data.website && data.website.trim()) {
        try {
            new URL(data.website);
        } catch (e) {
            errors.push('رابط الموقع الإلكتروني غير صحيح');
        }
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * دالة مساعدة لعرض رسائل الخطأ
 * @param {string[]} errors - قائمة الأخطاء
 * @returns {string} - رسالة الخطأ المنسقة
 */
export function formatErrorMessages(errors) {
    return errors.join('\n');
}
