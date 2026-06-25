/* =========================================================
   app.js
   منطق صفحة Customer Timeline داخل منصة مدعوم.
   لا يعتمد على أي مكتبة خارجية — Vanilla JS فقط.
   ========================================================= */

(function () {
  "use strict";

  // ---------- الحالة العامة ----------
  let allCustomers = [];
  let currentCustomer = null;
  let currentTimeline = [];
  let activeFilter = "all";

  // ---------- عناصر DOM ----------
  const customerListItemsEl = document.getElementById("customerListItems");
  const customerCountEl = document.getElementById("customerCount");
  const searchInput = document.getElementById("customerSearch");
  const searchBtn = document.getElementById("searchBtn");

  const emptyStateEl = document.getElementById("emptyState");
  const customerContentEl = document.getElementById("customerContent");

  const custAvatar = document.getElementById("custAvatar");
  const custName = document.getElementById("custName");
  const custPhone = document.getElementById("custPhone");
  const custEmail = document.getElementById("custEmail");
  const custTags = document.getElementById("custTags");

  const statTickets = document.getElementById("statTickets");
  const statMessages = document.getElementById("statMessages");
  const statWhatsapp = document.getElementById("statWhatsapp");
  const statNotes = document.getElementById("statNotes");

  const lastAgentAvatar = document.getElementById("lastAgentAvatar");
  const lastAgentName = document.getElementById("lastAgentName");
  const lastAgentTime = document.getElementById("lastAgentTime");

  const filtersEl = document.getElementById("filters");
  const timelineEl = document.getElementById("timeline");

  const addNoteBtn = document.getElementById("addNoteBtn");
  const noteModalOverlay = document.getElementById("noteModalOverlay");
  const closeNoteModal = document.getElementById("closeNoteModal");
  const cancelNoteBtn = document.getElementById("cancelNoteBtn");
  const saveNoteBtn = document.getElementById("saveNoteBtn");
  const noteText = document.getElementById("noteText");

  const toastEl = document.getElementById("toast");

  // ---------- أدوات مساعدة ----------

  const TYPE_LABELS = {
    message: "محادثة فورية",
    ticket: "تذكرة دعم",
    whatsapp: "واتساب",
    note: "ملاحظة داخلية"
  };

  const TYPE_ICONS = {
    message: "💬",
    ticket: "🎫",
    whatsapp: "🟢",
    note: "📌"
  };

  function initials(name) {
    if (!name) return "؟";
    const parts = name.trim().split(" ");
    return parts[0] ? parts[0].charAt(0) : "؟";
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.add("hidden"), 2200);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- عرض قائمة العملاء ----------

  function renderCustomerList(customers) {
    customerCountEl.textContent = customers.length;

    if (customers.length === 0) {
      customerListItemsEl.innerHTML = `<div class="timeline-empty">لا يوجد عملاء مطابقين</div>`;
      return;
    }

    customerListItemsEl.innerHTML = customers
      .map((c) => {
        const selected = currentCustomer && currentCustomer.id === c.id ? "selected" : "";
        const statusClass = c.tags.includes("vip") ? "vip" : c.status === "open" ? "open" : "resolved";
        return `
          <div class="customer-list-item ${selected}" data-id="${c.id}">
            <div class="cl-avatar">${initials(c.name)}</div>
            <div class="cl-info">
              <div class="cl-name">${escapeHtml(c.name)}</div>
              <div class="cl-sub">${escapeHtml(c.phone)}</div>
            </div>
            <span class="cl-status-dot ${statusClass}" title="${statusClass}"></span>
          </div>
        `;
      })
      .join("");

    // ربط الأحداث
    customerListItemsEl.querySelectorAll(".customer-list-item").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-id");
        selectCustomer(id);
      });
    });
  }

  // ---------- اختيار عميل وتحميل سجله ----------

  function selectCustomer(id) {
    const customer = allCustomers.find((c) => c.id === id);
    if (!customer) return;

    currentCustomer = customer;
    activeFilter = "all";
    resetFilterChips();

    // تحديث تحديد العنصر في القائمة
    customerListItemsEl.querySelectorAll(".customer-list-item").forEach((el) => {
      el.classList.toggle("selected", el.getAttribute("data-id") === id);
    });

    emptyStateEl.classList.add("hidden");
    customerContentEl.classList.remove("hidden");

    renderCustomerCard(customer);

    fetchCustomerTimeline(id).then((items) => {
      currentTimeline = items;
      renderStats(items);
      renderTimeline(items);
    });
  }

  function renderCustomerCard(c) {
    custAvatar.textContent = initials(c.name);
    custName.textContent = c.name;
    custPhone.textContent = c.phone;
    custEmail.textContent = c.email;

    const tagLabels = {
      vip: "عميل VIP",
      paid: "خطة مدفوعة",
      free: "خطة مجانية",
      atrisk: "بحاجة لمتابعة"
    };

    custTags.innerHTML = c.tags
      .map((t) => `<span class="tag ${t}">${tagLabels[t] || t}</span>`)
      .join("");

    lastAgentAvatar.textContent = initials(c.lastAgent.name);
    lastAgentName.textContent = `${c.lastAgent.name} — ${c.lastAgent.role}`;
    lastAgentTime.textContent = c.lastAgent.time;
  }

  function renderStats(items) {
    statTickets.textContent = items.filter((i) => i.type === "ticket").length;
    statMessages.textContent = items.filter((i) => i.type === "message").length;
    statWhatsapp.textContent = items.filter((i) => i.type === "whatsapp").length;
    statNotes.textContent = items.filter((i) => i.type === "note").length;
  }

  // ---------- عرض التايم لاين ----------

  function renderTimeline(items) {
    const filtered =
      activeFilter === "all" ? items : items.filter((i) => i.type === activeFilter);

    if (filtered.length === 0) {
      timelineEl.innerHTML = `<div class="timeline-empty">لا توجد عناصر من هذا النوع في سجل العميل</div>`;
      return;
    }

    timelineEl.innerHTML = filtered.map(renderTimelineItem).join("");
  }

  function renderTimelineItem(item) {
    const typeLabel = TYPE_LABELS[item.type] || item.type;
    const icon = TYPE_ICONS[item.type] || "•";

    let statusBadge = "";
    if (item.type === "ticket" && item.status) {
      const statusText = item.status === "open" ? "مفتوحة" : "مغلقة";
      statusBadge = `<span class="badge ${item.status}">${statusText}</span>`;
    }

    return `
      <div class="tl-item">
        <span class="tl-dot ${item.type}">${icon}</span>
        <div class="tl-card ${item.type}">
          <div class="tl-head">
            <span class="tl-type-label ${item.type}">${icon} ${typeLabel}</span>
            <span class="tl-time">${escapeHtml(item.time)}</span>
          </div>
          <div class="tl-title">${escapeHtml(item.title)}</div>
          <div class="tl-body">${escapeHtml(item.body)}</div>
          <div class="tl-foot">
            ${statusBadge}
            <span class="badge agent">👤 ${escapeHtml(item.agent)}</span>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- الفلاتر ----------

  function resetFilterChips() {
    filtersEl.querySelectorAll(".filter-chip").forEach((chip) => {
      chip.classList.toggle("active", chip.getAttribute("data-filter") === "all");
    });
  }

  filtersEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".filter-chip");
    if (!chip) return;

    filtersEl.querySelectorAll(".filter-chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    activeFilter = chip.getAttribute("data-filter");

    renderTimeline(currentTimeline);
  });

  // ---------- البحث ----------

  function applySearch() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      renderCustomerList(allCustomers);
      return;
    }
    const filtered = allCustomers.filter((c) => {
      return (
        c.name.toLowerCase().includes(q) ||
        c.phone.replace(/\s/g, "").includes(q.replace(/\s/g, "")) ||
        c.email.toLowerCase().includes(q)
      );
    });
    renderCustomerList(filtered);
  }

  searchBtn.addEventListener("click", applySearch);
  searchInput.addEventListener("input", applySearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applySearch();
  });

  // ---------- المودال: إضافة ملاحظة داخلية ----------

  function openNoteModal() {
    if (!currentCustomer) {
      showToast("اختر عميلًا أولًا");
      return;
    }
    noteText.value = "";
    noteModalOverlay.classList.remove("hidden");
    noteText.focus();
  }

  function closeModal() {
    noteModalOverlay.classList.add("hidden");
  }

  addNoteBtn.addEventListener("click", openNoteModal);
  closeNoteModal.addEventListener("click", closeModal);
  cancelNoteBtn.addEventListener("click", closeModal);

  noteModalOverlay.addEventListener("click", (e) => {
    if (e.target === noteModalOverlay) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !noteModalOverlay.classList.contains("hidden")) {
      closeModal();
    }
  });

  saveNoteBtn.addEventListener("click", () => {
    const text = noteText.value.trim();
    if (!text) {
      showToast("اكتب نص الملاحظة أولًا");
      return;
    }
    if (!currentCustomer) return;

    saveInternalNote(currentCustomer.id, text).then((newNote) => {
      currentTimeline.unshift(newNote);
      renderStats(currentTimeline);
      renderTimeline(currentTimeline);
      closeModal();
      showToast("تم حفظ الملاحظة الداخلية بنجاح");
    });
  });

  // ---------- تحميل أولي ----------

  function init() {
    fetchCustomers().then((customers) => {
      allCustomers = customers;
      renderCustomerList(customers);

      // اختيار أول عميل تلقائيًا لعرض مثال مباشرة
      if (customers.length > 0) {
        selectCustomer(customers[0].id);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
