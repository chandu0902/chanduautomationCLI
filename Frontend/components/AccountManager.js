"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

function EyeIcon({ open }) {
  if (open) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function PasswordInput({ label, value, onChange, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-2.5 text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 pr-10"
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
        >
          <EyeIcon open={show} />
        </button>
      </div>
    </div>
  );
}

function SelectInput({ label, value, onChange, options, placeholder }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 appearance-none cursor-pointer"
      >
        <option value="" className="bg-slate-900">{placeholder || "Select..."}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-slate-900">{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function TextInput({ label, value, onChange, placeholder }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-2.5 text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20"
      />
    </div>
  );
}

export default function AccountManager() {
  const [accounts, setAccounts] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mainAccounts, setMainAccounts] = useState([]);

  // Form state
  const [form, setForm] = useState({
    Trade_Account: "",
    Email: "",
    Exchange: "",
    Account_Type: "",
    Api_Key: "",
    Secret_Key: "",
    vaultAddress: "",
    parentAccount: "",
  });

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await api.get("/api/accounts");
      setAccounts(data);
    } catch {
      setAccounts([]);
    }
  }, []);

  const fetchMainAccounts = useCallback(async () => {
    try {
      const data = await api.get("/api/accounts/main?exchange=Hyperliquid");
      setMainAccounts(data);
    } catch {
      setMainAccounts([]);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  useEffect(() => {
    if (form.Exchange === "Hyperliquid" && form.Account_Type === "Sub Account") {
      fetchMainAccounts();
    }
  }, [form.Exchange, form.Account_Type, fetchMainAccounts]);

  const resetForm = () => {
    setForm({ Trade_Account: "", Email: "", Exchange: "", Account_Type: "", Api_Key: "", Secret_Key: "", vaultAddress: "", parentAccount: "" });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.post("/api/accounts", {
        Trade_Account: form.Trade_Account,
        Email: form.Email,
        Exchange: form.Exchange,
        Account_Type: form.Account_Type || null,
        Api_Key: form.Api_Key || null,
        Secret_Key: form.Secret_Key || null,
        vaultAddress: form.vaultAddress || null,
      });
      resetForm();
      setShowModal(false);
      fetchAccounts();
    } catch (err) {
      console.error("Failed to save account:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.del(`/api/accounts/${id}`);
      fetchAccounts();
    } catch (err) {
      console.error("Failed to delete account:", err);
    }
  };

  const canSave = form.Trade_Account && form.Email && form.Exchange;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-slate-500 font-mono">{accounts.length} account{accounts.length !== 1 ? "s" : ""}</span>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 rounded-lg bg-gradient-to-r from-blue-500 to-violet-600 text-white text-sm font-semibold shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 hover:from-blue-400 hover:to-violet-500 transition-all duration-200 cursor-pointer"
        >
          + Add Account
        </button>
      </div>

      {/* Accounts Table */}
      {accounts.length > 0 && (
        <div className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800/50">
                  <th className="text-left px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Account</th>
                  <th className="text-left px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Exchange</th>
                  <th className="text-left px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Type</th>
                  <th className="text-left px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">API Key</th>
                  <th className="text-left px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                  <th className="text-right px-5 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((acc) => (
                  <tr key={acc.id} className="border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex flex-col">
                        <span className="text-white font-medium">{acc.Trade_Account}</span>
                        <span className="text-xs text-slate-500 font-mono">{acc.Email}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`text-xs font-bold px-2.5 py-1 rounded-full uppercase tracking-wider ${
                        acc.Exchange === "Deribit"
                          ? "text-blue-400 bg-blue-500/10"
                          : "text-emerald-400 bg-emerald-500/10"
                      }`}>
                        {acc.Exchange}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-400 text-xs font-mono">{acc.Account_Type || "-"}</td>
                    <td className="px-5 py-3 text-slate-500 text-xs font-mono">{acc.Api_Key || "-"}</td>
                    <td className="px-5 py-3">
                      <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                        acc.Status === "Active" ? "text-emerald-400 bg-emerald-500/10" :
                        acc.Status === "Inactive" ? "text-slate-400 bg-slate-500/10" :
                        "text-red-400 bg-red-500/10"
                      }`}>
                        {acc.Status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => handleDelete(acc.id)}
                        className="text-xs text-red-400/60 hover:text-red-400 font-semibold transition-colors cursor-pointer"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {accounts.length === 0 && (
        <div className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-8 text-center">
          <span className="text-sm text-slate-600">No accounts added yet</span>
        </div>
      )}

      {/* Add Account Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg mx-4 rounded-2xl border border-slate-700/80 bg-gradient-to-b from-slate-900 to-[#0a0e17] shadow-2xl shadow-black/50">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800/50">
              <h3 className="text-lg font-bold text-white">Add Account</h3>
              <button
                onClick={() => { resetForm(); setShowModal(false); }}
                className="text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
              <TextInput
                label="Account Name"
                value={form.Trade_Account}
                onChange={(v) => setForm({ ...form, Trade_Account: v })}
                placeholder="Enter account name"
              />

              <TextInput
                label="Email"
                value={form.Email}
                onChange={(v) => setForm({ ...form, Email: v })}
                placeholder="Enter email"
              />

              <SelectInput
                label="Exchange"
                value={form.Exchange}
                onChange={(v) => setForm({ ...form, Exchange: v, Account_Type: "", Api_Key: "", Secret_Key: "", vaultAddress: "", parentAccount: "" })}
                options={[
                  { value: "Deribit", label: "Deribit" },
                  { value: "Hyperliquid", label: "Hyperliquid" },
                ]}
                placeholder="Select Exchange"
              />

              {/* Deribit fields */}
              {form.Exchange === "Deribit" && (
                <>
                  <PasswordInput
                    label="API Key"
                    value={form.Api_Key}
                    onChange={(v) => setForm({ ...form, Api_Key: v })}
                    placeholder="Enter API key"
                  />
                  <PasswordInput
                    label="Secret Key"
                    value={form.Secret_Key}
                    onChange={(v) => setForm({ ...form, Secret_Key: v })}
                    placeholder="Enter secret key"
                  />
                </>
              )}

              {/* Hyperliquid fields */}
              {form.Exchange === "Hyperliquid" && (
                <>
                  <SelectInput
                    label="Hype Account Type"
                    value={form.Account_Type}
                    onChange={(v) => setForm({ ...form, Account_Type: v, Api_Key: "", Secret_Key: "", vaultAddress: "", parentAccount: "" })}
                    options={[
                      { value: "Main Account", label: "Main Account" },
                      { value: "Sub Account", label: "Sub Account" },
                    ]}
                    placeholder="Select Account Type"
                  />

                  {/* Main Account fields */}
                  {form.Account_Type === "Main Account" && (
                    <>
                      <PasswordInput
                        label="API Key"
                        value={form.Api_Key}
                        onChange={(v) => setForm({ ...form, Api_Key: v })}
                        placeholder="Enter API key"
                      />
                      <PasswordInput
                        label="Secret Key"
                        value={form.Secret_Key}
                        onChange={(v) => setForm({ ...form, Secret_Key: v })}
                        placeholder="Enter secret key"
                      />
                    </>
                  )}

                  {/* Sub Account fields */}
                  {form.Account_Type === "Sub Account" && (
                    <>
                      <SelectInput
                        label="Select Hype Main Account"
                        value={form.parentAccount}
                        onChange={(v) => setForm({ ...form, parentAccount: v })}
                        options={mainAccounts.map((a) => ({
                          value: String(a.id),
                          label: a.Trade_Account,
                        }))}
                        placeholder="Select Hype Main Account"
                      />
                      <PasswordInput
                        label="SubAccount Api Key"
                        value={form.Api_Key}
                        onChange={(v) => setForm({ ...form, Api_Key: v })}
                        placeholder="Enter SubAccount Api Key"
                      />
                    </>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-800/50">
              <button
                onClick={() => { resetForm(); setShowModal(false); }}
                className="px-5 py-2.5 rounded-lg border border-slate-700/50 text-sm text-slate-400 font-semibold hover:bg-slate-800/50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!canSave || saving}
                className="px-6 py-2.5 rounded-lg bg-gradient-to-r from-blue-500 to-violet-600 text-white text-sm font-semibold shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 hover:from-blue-400 hover:to-violet-500 transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? "Saving..." : "Add Account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
