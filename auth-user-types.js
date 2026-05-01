/**
 * ملف المصادقة الخاص بنوعي المستخدمين (أفراد وشركات)
 * يحتوي على دوال إنشاء الحسابات والدخول لكل نوع
 */

import { supabase, debugAuthError } from './api-config.js';
import { logActivity } from './activity-service.js';
import { validateIndividualData, validateCompanyData } from './auth-validation.js';
import { USER_ROLES } from './constants.js';

/**
 * إنشاء حساب فرد جديد
 * @param {Object} data - بيانات الفرد
 * @returns {Object} - { success: boolean, user: Object, error: string }
 */
export async function signUpIndividual(data, options = {}) {
    try {
        const { turnstileToken } = options;
        
        // التحقق من صحة البيانات
        const validation = validateIndividualData(data);
        if (!validation.isValid) {
            return {
                success: false,
                error: validation.errors.join('\n')
            };
        }

        // التحقق من عدم وجود بريد إلكتروني مسجل
        const { data: existingUser } = await supabase
            .from('profiles')
            .select('id')
            .eq('email', data.email)
            .maybeSingle();

        if (existingUser) {
            return {
                success: false,
                error: 'هذا البريد الإلكتروني مسجل بالفعل'
            };
        }

        // إنشاء حساب في Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email: data.email,
            password: data.password,
            options: {
                data: {
                    user_type: 'individual',
                    first_name: data.firstName,
                    last_name: data.lastName,
                    phone: data.phone
                },
                emailRedirectTo: `${window.location.origin}/sign-in.html`
            }
        });

        if (authError) {
            debugAuthError(authError);
            return {
                success: false,
                error: authError.message || 'فشل في إنشاء الحساب'
            };
        }

        // إنشاء ملف شخصي في جدول profiles
        const { error: profileError } = await supabase
            .from('profiles')
            .insert([{
                id: authData.user.id,
                email: data.email,
                username: data.email.split('@')[0],
                user_type: 'individual',
                phone: data.phone,
                date_of_birth: data.dateOfBirth || null,
                gender: data.gender || null,
                address: data.address || null,
                city: data.city || null,
                country: data.country || null,
                is_verified: false,
                role: 'customer'
            }]);

        if (profileError) {
            console.error('Profile creation error:', profileError);
            return {
                success: false,
                error: 'فشل في إنشاء الملف الشخصي'
            };
        }

        // إنشاء سجل في جدول individuals
        const { error: individualError } = await supabase
            .from('individuals')
            .insert([{
                user_id: authData.user.id,
                first_name: data.firstName,
                last_name: data.lastName,
                date_of_birth: data.dateOfBirth || null,
                national_id: data.nationalId || null,
                address: data.address || null,
                city: data.city || null,
                country: data.country || null,
                gender: data.gender || null
            }]);

        if (individualError) {
            console.error('Individual profile creation error:', individualError);
        }

        // تسجيل النشاط
        await logActivity('signup_individual', { email: data.email, hasTurnstile: !!turnstileToken }).catch(() => {});

        return {
            success: true,
            user: authData.user,
            message: 'تم إنشاء الحساب بنجاح! يرجى تأكيد بريدك الإلكتروني.'
        };

    } catch (error) {
        console.error('Sign up individual error:', error);
        return {
            success: false,
            error: 'حدث خطأ أثناء إنشاء الحساب'
        };
    }
}

/**
 * إنشاء حساب شركة جديد
 * @param {Object} data - بيانات الشركة
 * @returns {Object} - { success: boolean, user: Object, error: string }
 */
export async function signUpCompany(data, options = {}) {
    try {
        const { turnstileToken } = options;
        
        // التحقق من صحة البيانات
        const validation = validateCompanyData(data);
        if (!validation.isValid) {
            return {
                success: false,
                error: validation.errors.join('\n')
            };
        }

        // التحقق من عدم وجود بريد إلكتروني مسجل
        const { data: existingUser } = await supabase
            .from('profiles')
            .select('id')
            .eq('email', data.email)
            .maybeSingle();

        if (existingUser) {
            return {
                success: false,
                error: 'هذا البريد الإلكتروني مسجل بالفعل'
            };
        }

        // التحقق من عدم وجود رقم سجل تجاري مسجل
        const { data: existingCompany } = await supabase
            .from('companies')
            .select('id')
            .eq('commercial_registration_number', data.commercialRegistrationNumber)
            .maybeSingle();

        if (existingCompany) {
            return {
                success: false,
                error: 'رقم السجل التجاري مسجل بالفعل'
            };
        }

        // إنشاء حساب في Supabase Auth
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email: data.email,
            password: data.password,
            options: {
                data: {
                    user_type: 'company',
                    company_name: data.companyName,
                    phone: data.phone
                },
                emailRedirectTo: `${window.location.origin}/sign-in.html`
            }
        });

        if (authError) {
            debugAuthError(authError);
            return {
                success: false,
                error: authError.message || 'فشل في إنشاء الحساب'
            };
        }

        // إنشاء ملف شخصي في جدول profiles
        const { error: profileError } = await supabase
            .from('profiles')
            .insert([{
                id: authData.user.id,
                email: data.email,
                username: data.companyName.replace(/\s+/g, '_').toLowerCase(),
                user_type: 'company',
                phone: data.phone,
                address: data.address || null,
                city: data.city || null,
                country: data.country || null,
                is_verified: false,
                role: USER_ROLES.SUPER_USER
            }]);

        if (profileError) {
            console.error('Profile creation error:', profileError);
            return {
                success: false,
                error: 'فشل في إنشاء الملف الشخصي'
            };
        }

        // إنشاء سجل في جدول companies
        const { error: companyError } = await supabase
            .from('companies')
            .insert([{
                user_id: authData.user.id,
                company_name: data.companyName,
                commercial_registration_number: data.commercialRegistrationNumber,
                company_email: data.companyEmail,
                company_phone: data.companyPhone,
                address: data.address,
                city: data.city,
                country: data.country,
                website: data.website || null,
                industry: data.industry || null,
                employee_count: data.employeeCount || null,
                tax_id: data.taxId || null
            }]);

        if (companyError) {
            console.error('Company profile creation error:', companyError);
            return {
                success: false,
                error: 'فشل في إنشاء ملف الشركة'
            };
        }

        // تسجيل النشاط
        await logActivity('signup_company', { email: data.email, company: data.companyName, hasTurnstile: !!turnstileToken }).catch(() => {});

        return {
            success: true,
            user: authData.user,
            message: 'تم إنشاء حساب الشركة بنجاح! يرجى تأكيد بريدك الإلكتروني.'
        };

    } catch (error) {
        console.error('Sign up company error:', error);
        return {
            success: false,
            error: 'حدث خطأ أثناء إنشاء الحساب'
        };
    }
}

/**
 * الدخول مع نوع المستخدم
 * @param {string} identifier - البريد الإلكتروني أو اسم المستخدم
 * @param {string} password - كلمة المرور
 * @returns {Object} - { success: boolean, user: Object, userType: string, error: string }
 */
export async function signInWithUserType(identifier, password) {
    try {
        // جلب بيانات المستخدم
        const { data: profile } = await supabase
            .from('profiles')
            .select('id, email, user_type')
            .or(`email.eq.${identifier},username.eq.${identifier}`)
            .maybeSingle();

        if (!profile) {
            return {
                success: false,
                error: 'البريد الإلكتروني أو اسم المستخدم غير موجود'
            };
        }

        // محاولة تسجيل الدخول
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email: profile.email,
            password
        });

        if (authError) {
            debugAuthError(authError);
            return {
                success: false,
                error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة'
            };
        }

        // تسجيل النشاط
        await logActivity('signin', { email: profile.email, user_type: profile.user_type }).catch(() => {});

        return {
            success: true,
            user: authData.user,
            userType: profile.user_type,
            profile
        };

    } catch (error) {
        console.error('Sign in error:', error);
        return {
            success: false,
            error: 'حدث خطأ أثناء تسجيل الدخول'
        };
    }
}

/**
 * جلب بيانات الفرد
 * @param {string} userId - معرف المستخدم
 * @returns {Object} - بيانات الفرد
 */
export async function getIndividualProfile(userId) {
    try {
        const { data, error } = await supabase
            .from('individuals')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;
        return data;
    } catch (error) {
        console.error('Get individual profile error:', error);
        return null;
    }
}

/**
 * جلب بيانات الشركة
 * @param {string} userId - معرف المستخدم
 * @returns {Object} - بيانات الشركة
 */
export async function getCompanyProfile(userId) {
    try {
        const { data, error } = await supabase
            .from('companies')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;
        return data;
    } catch (error) {
        console.error('Get company profile error:', error);
        return null;
    }
}
