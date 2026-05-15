import { SupabaseIntegration } from '../supabase-integration.js';

export class MessageRealtime {
  constructor({ onMessage, onStatus, onError } = {}) {
    this.channel = null;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onError = onError;
  }

  async subscribe() {
    this.unsubscribe();
    const supabase = await SupabaseIntegration.initializeSupabase();
    const userId = await SupabaseIntegration.getCurrentUserId();
    if (!userId) return null;

    this.channel = supabase
      .channel(`wa-messages-${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `user_id=eq.${userId}`,
      }, (payload) => {
        this.onMessage?.(payload.new, payload);
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `user_id=eq.${userId}`,
      }, (payload) => {
        this.onMessage?.(payload.new, payload);
      })
      .on('postgres_changes', {
        event: 'DELETE',
        schema: 'public',
        table: 'messages',
        filter: `user_id=eq.${userId}`,
      }, (payload) => {
        this.onMessage?.(payload.old, payload);
      })
      .subscribe((status, error) => {
        this.onStatus?.(status);
        if (error) this.onError?.(error);
      });

    return this.channel;
  }

  unsubscribe() {
    if (this.channel) {
      this.channel.unsubscribe();
      this.channel = null;
    }
  }
}
