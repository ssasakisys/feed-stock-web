import { useState, useEffect, useCallback, useMemo } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceDot,
} from "recharts";
import {
  Plus, Trash2, ChevronLeft, AlertTriangle, CalendarPlus,
  Warehouse, Package, X, Gauge, Download, Settings2, Home as HomeIcon,
  GripVertical, TrendingUp, TrendingDown, CalendarCheck, FileDown, Check, CalendarDays,
} from "lucide-react";
import Papa from "papaparse";

const STORAGE_KEY = "feed-inventory-v1";
const GAUGE_MAX_DAYS = 30;

const FONT_IMPORT =
  "@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=IBM+Plex+Sans+JP:wght@400;500;700&family=IBM+Plex+Mono:wght@500;600&display=swap');";

const COLORS = {
  bg: "#161B22",
  panel: "#1E2530",
  panelAlt: "#252D3A",
  border: "#333F4F",
  text: "#EDEBE2",
  textDim: "#9AA5B1",
  sage: "#7C9A82",
  amber: "#D9A544",
  rust: "#C1502E",
  gray: "#5B6572",
  steel: "#5C7C99",
};

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(d1, d2) {
  return Math.round((new Date(d2) - new Date(d1)) / (1000 * 60 * 60 * 24));
}

function fmtDate(d) {
  const dt = new Date(d);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

function fmtDateFull(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
}

function sortedLogs(stock) {
  return [...(stock.logs || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
}

// 直近2件の記録から1日使用量を算出。手入力優先設定ならそちらを使う。
function computeDailyUsage(stock) {
  if (stock.useManual && stock.manualDailyUsage != null && stock.manualDailyUsage > 0) {
    return { value: stock.manualDailyUsage, source: "manual" };
  }
  const logs = sortedLogs(stock);
  // 直近から過去にさかのぼり、最初に見つかった「有効なペア」(納品による増加ではない区間)の使用量を採用する。
  // これにより、納品直後（残数が増えた直後）は次の記録が入るまで直前の使用量を参照し続ける。
  for (let i = logs.length - 1; i >= 1; i--) {
    const prev = logs[i - 1];
    const last = logs[i];
    const days = daysBetween(prev.date, last.date);
    const used = prev.remaining - last.remaining;
    if (days > 0 && used >= 0) {
      return { value: used / days, source: "calc" };
    }
    // このペアは納品等で増加している(無効) → さらに過去のペアを確認する
  }
  if (stock.manualDailyUsage != null && stock.manualDailyUsage > 0) {
    return { value: stock.manualDailyUsage, source: "manual" };
  }
  return { value: null, source: logs.length < 2 ? "none" : "invalid" };
}

function computeDaysLeft(stock) {
  const logs = sortedLogs(stock);
  const latest = logs[logs.length - 1];
  const usage = computeDailyUsage(stock);
  if (!latest || !usage.value || usage.value <= 0) return null;
  return latest.remaining / usage.value;
}

function computeStockoutDate(stock) {
  const logs = sortedLogs(stock);
  const latest = logs[logs.length - 1];
  const daysLeft = computeDaysLeft(stock);
  if (!latest || daysLeft == null) return null;
  const d = new Date(latest.date);
  d.setDate(d.getDate() + Math.floor(daysLeft));
  return d.toISOString().slice(0, 10);
}

// 表示用の「残り日数」は、記録した日からではなく本日から数える
// (記録から日数が経っても、日を追うごとにきちんと減っていくようにするため)
function computeDaysUntilStockout(stockoutDate) {
  if (!stockoutDate) return null;
  return daysBetween(todayStr(), stockoutDate);
}

// 直近の有効な使用量と、その一つ前の有効な使用量を比較し、大きく変化していれば検知する
// (使用量急減=離反や頭数減少のシグナル、急増=増頭や追加提案のチャンスの可能性)
const USAGE_CHANGE_THRESHOLD = 0.3; // 30%以上の変化で検知
function computeUsageTrend(stock) {
  const logs = sortedLogs(stock);
  const validUsages = [];
  for (let i = logs.length - 1; i >= 1 && validUsages.length < 2; i--) {
    const prev = logs[i - 1];
    const last = logs[i];
    const days = daysBetween(prev.date, last.date);
    const used = prev.remaining - last.remaining;
    if (days > 0 && used >= 0) {
      validUsages.push({ value: used / days });
    }
  }
  if (validUsages.length < 2 || validUsages[1].value <= 0) {
    return { direction: null, changePct: null };
  }
  const [current, previous] = validUsages;
  const changePct = (current.value - previous.value) / previous.value;
  let direction = null;
  if (changePct >= USAGE_CHANGE_THRESHOLD) direction = "up";
  else if (changePct <= -USAGE_CHANGE_THRESHOLD) direction = "down";
  return { direction, changePct, current: current.value, previous: previous.value };
}

// ある商品の全在庫アイテム(全農家分)について、月ごとの消費量合計を集計する。
// 各記録区間の消費量は、区間終了日(=記録した日)の月に計上する簡易的な集計方法。
function computeMonthlyConsumption(stocksForProduct) {
  const totals = {};
  stocksForProduct.forEach((stock) => {
    const logs = sortedLogs(stock);
    for (let i = 1; i < logs.length; i++) {
      const prev = logs[i - 1];
      const last = logs[i];
      const days = daysBetween(prev.date, last.date);
      const used = prev.remaining - last.remaining;
      if (days > 0 && used >= 0) {
        const month = last.date.slice(0, 7);
        totals[month] = (totals[month] || 0) + used;
      }
    }
  });
  return Object.entries(totals)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, total]) => ({ month, total: Math.round(total * 10) / 10 }));
}

// 指定した日付の時点での予想残数（納品完了記録時の参考値として使用）
function projectRemainingOnDate(stock, dateStr) {
  const logs = sortedLogs(stock);
  const latest = logs[logs.length - 1];
  if (!latest) return null;
  const usage = computeDailyUsage(stock);
  if (!usage.value) return latest.remaining;
  const daysSince = daysBetween(latest.date, dateStr);
  if (daysSince <= 0) return latest.remaining;
  return Math.max(0, latest.remaining - usage.value * daysSince);
}

function getStatus(daysLeft) {
  if (daysLeft == null) return "unknown";
  if (daysLeft <= 3) return "critical";
  if (daysLeft <= 7) return "warning";
  return "ok";
}

const STATUS_COLOR = {
  critical: COLORS.rust,
  warning: COLORS.amber,
  ok: COLORS.sage,
  unknown: COLORS.gray,
};
const STATUS_LABEL = {
  critical: "危険",
  warning: "注意",
  ok: "正常",
  unknown: "算出不可",
};

function gcalUrl(title, dateStr, details) {
  const d = new Date(dateStr);
  const end = new Date(d);
  end.setDate(end.getDate() + 1);
  const fmt = (dt) => dt.toISOString().slice(0, 10).replace(/-/g, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${fmt(d)}/${fmt(end)}`,
    details: details || "",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function downloadCsv(filename, headers, rows) {
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))];
  const csv = "\uFEFF" + lines.join("\r\n"); // BOM付きでExcelでも文字化けしないように
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadIcs(items) {
  const pad = (n) => String(n).padStart(2, "0");
  const toIcsDate = (dateStr) => dateStr.replace(/-/g, "");
  let body =
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//feed-inventory//JP\r\nCALSCALE:GREGORIAN\r\n";
  items.forEach((it) => {
    const dt = new Date(it.alertDate);
    const end = new Date(dt);
    end.setDate(end.getDate() + 1);
    body += "BEGIN:VEVENT\r\n";
    body += `UID:${uid()}@feed-inventory\r\n`;
    body += `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z\r\n`;
    body += `DTSTART;VALUE=DATE:${toIcsDate(it.alertDate)}\r\n`;
    body += `DTEND;VALUE=DATE:${toIcsDate(end.toISOString().slice(0, 10))}\r\n`;
    body += `SUMMARY:${it.title}\r\n`;
    body += `DESCRIPTION:${it.details || ""}\r\n`;
    body += "END:VEVENT\r\n";
  });
  body += "END:VCALENDAR\r\n";
  const blob = new Blob([body], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "inventory-alerts.ics";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function Gauge_({ daysLeft, status }) {
  const pct =
    daysLeft == null ? 0 : Math.max(4, Math.min(100, (daysLeft / GAUGE_MAX_DAYS) * 100));
  const color = STATUS_COLOR[status];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 120 }}>
      <div
        style={{
          position: "relative",
          height: 10,
          borderRadius: 3,
          background: "#11151B",
          border: `1px solid ${COLORS.border}`,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${pct}%`,
            background: color,
            transition: "width 0.4s ease",
          }}
        />
        {[25, 50, 75].map((t) => (
          <div
            key={t}
            style={{
              position: "absolute",
              left: `${t}%`,
              top: 0,
              bottom: 0,
              width: 1,
              background: "rgba(0,0,0,0.35)",
            }}
          />
        ))}
      </div>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 12,
          color: color,
          fontWeight: 600,
          letterSpacing: 0.3,
        }}
      >
        {daysLeft == null ? "残日数 ―" : `残り ${Math.floor(daysLeft)}日`}
      </div>
    </div>
  );
}

function TrendBadge({ trend }) {
  if (!trend || !trend.direction) return null;
  const isUp = trend.direction === "up";
  const color = isUp ? COLORS.steel : COLORS.rust;
  const label = isUp ? "使用量急増" : "使用量急減";
  const Icon = isUp ? TrendingUp : TrendingDown;
  const pct = Math.round(Math.abs(trend.changePct) * 100);
  return (
    <span
      title={`前回比 ${isUp ? "+" : "-"}${pct}%`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600,
        padding: "2px 6px", borderRadius: 3, border: `1px solid ${color}88`,
        color, background: `${color}14`, whiteSpace: "nowrap",
      }}
    >
      <Icon size={11} /> {label}
    </span>
  );
}

function VisitDateCell({ farm, onUpdateVisitDate, stockoutDate }) {
  const [editing, setEditing] = useState(false);
  if (!farm) return null;
  const date = farm.nextVisitDate || "";

  if (editing) {
    return (
      <input
        type="date"
        autoFocus
        value={date}
        onChange={(e) => onUpdateVisitDate(farm.id, e.target.value)}
        onBlur={() => setEditing(false)}
        style={{ ...inputStyle, width: "100%", fontSize: 12 }}
      />
    );
  }

  if (!date) {
    return (
      <button
        onClick={() => setEditing(true)}
        style={{
          display: "flex", alignItems: "center", gap: 4, width: "100%",
          background: "transparent", border: `1px dashed ${COLORS.border}`, borderRadius: 4,
          color: COLORS.textDim, fontSize: 11, padding: "5px 8px", cursor: "pointer",
        }}
      >
        <CalendarCheck size={12} /> 訪問日を設定
      </button>
    );
  }

  const daysUntil = daysBetween(todayStr(), date);
  let color = COLORS.sage;
  let label;
  if (daysUntil < 0) { color = COLORS.rust; label = `予定より${Math.abs(daysUntil)}日超過`; }
  else if (daysUntil === 0) { color = COLORS.amber; label = "本日訪問予定"; }
  else if (daysUntil <= 2) { color = COLORS.amber; label = `${daysUntil}日後に訪問`; }
  else { label = `${daysUntil}日後に訪問`; }
  const mismatch = stockoutDate && stockoutDate < date;

  return (
    <button
      onClick={() => setEditing(true)}
      title="クリックして訪問予定日を変更"
      style={{
        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, width: "100%",
        background: `${color}14`, border: `1px solid ${color}77`, borderRadius: 4,
        color, fontSize: 11, padding: "5px 8px", cursor: "pointer", fontWeight: 600,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}><CalendarCheck size={12} /> {fmtDateFull(date)}</span>
      <span style={{ fontWeight: 400 }}>{label}</span>
      {mismatch && <span style={{ color: COLORS.rust, fontWeight: 600 }}>⚠ 訪問前に在庫切れの見込み</span>}
    </button>
  );
}

function StatusBadge({ status }) {
  const color = STATUS_COLOR[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.5,
        padding: "3px 8px",
        borderRadius: 3,
        border: `1px solid ${color}`,
        color: color,
        background: `${color}1A`,
        textTransform: "uppercase",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function Btn({ children, onClick, variant = "default", style, ...rest }) {
  const variants = {
    default: { background: COLORS.panelAlt, color: COLORS.text, border: `1px solid ${COLORS.border}` },
    primary: { background: COLORS.steel, color: "#fff", border: `1px solid ${COLORS.steel}` },
    danger: { background: "transparent", color: COLORS.rust, border: `1px solid ${COLORS.rust}55` },
    ghost: { background: "transparent", color: COLORS.textDim, border: "1px solid transparent" },
  };
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "'IBM Plex Sans JP', sans-serif",
        fontSize: 13,
        fontWeight: 500,
        padding: "7px 12px",
        borderRadius: 5,
        cursor: "pointer",
        ...variants[variant],
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: COLORS.textDim }}>
      {label}
      {children}
    </label>
  );
}

const inputStyle = {
  background: "#11151B",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 4,
  padding: "7px 9px",
  color: COLORS.text,
  fontSize: 13,
  fontFamily: "'IBM Plex Sans JP', sans-serif",
  outline: "none",
};

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("home");
  const [selectedStockId, setSelectedStockId] = useState(null);
  const [leadDays, setLeadDays] = useState(3);
  const [filterStatus, setFilterStatus] = useState("all");
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORAGE_KEY, false);
        if (res && res.value) {
          setData(JSON.parse(res.value));
        } else {
          setData({ farms: [], products: [], stocks: [] });
        }
      } catch (e) {
        setData({ farms: [], products: [], stocks: [] });
      }
      setLoading(false);
    })();
  }, []);

  const save = useCallback(async (next) => {
    setData(next);
    try {
      const res = await window.storage.set(STORAGE_KEY, JSON.stringify(next), false);
      if (!res) setError("保存に失敗しました");
    } catch (e) {
      setError("保存エラー: " + e.message);
    }
  }, []);

  const farmName = (id) => data?.farms.find((f) => f.id === id)?.name || "?";
  const productInfo = (id) => data?.products.find((p) => p.id === id) || { name: "?", unit: "" };

  const enrichedStocks = useMemo(() => {
    if (!data) return [];
    return data.stocks.map((s) => {
      const usage = computeDailyUsage(s);
      const stockoutDate = computeStockoutDate(s);
      const daysLeft = computeDaysUntilStockout(stockoutDate);
      const status = getStatus(daysLeft);
      const logs = sortedLogs(s);
      const latest = logs[logs.length - 1];
      let projectedRemaining = null;
      if (latest) {
        if (!usage.value) {
          projectedRemaining = latest.remaining;
        } else {
          const daysSince = daysBetween(latest.date, todayStr());
          projectedRemaining =
            daysSince <= 0 ? latest.remaining : Math.max(0, latest.remaining - usage.value * daysSince);
        }
      }
      const trend = computeUsageTrend(s);
      return { ...s, daysLeft, status, usage, stockoutDate, latest, projectedRemaining, trend };
    });
  }, [data]);

  const sortedByUrgency = useMemo(() => {
    const rank = { critical: 0, warning: 1, unknown: 2, ok: 3 };
    return [...enrichedStocks].sort((a, b) => {
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      if (a.daysLeft == null) return 1;
      if (b.daysLeft == null) return -1;
      return a.daysLeft - b.daysLeft;
    });
  }, [enrichedStocks]);

  const alertItems = useMemo(
    () => sortedByUrgency.filter((s) => s.daysLeft != null && s.daysLeft <= leadDays + 7),
    [sortedByUrgency, leadDays]
  );

  if (loading) {
    return (
      <div style={{ background: COLORS.bg, color: COLORS.textDim, padding: 40, fontFamily: "sans-serif" }}>
        読み込み中...
      </div>
    );
  }

  // ---- Actions ----
  const seedSampleData = () => {
    const dstr = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    const mkLog = (offset, remaining) => ({ id: uid(), date: dstr(offset), remaining });

    const pId1 = uid(), pId2 = uid(), pId3 = uid();
    const products = [
      { id: pId1, name: "配合飼料A", unit: "袋" },
      { id: pId2, name: "配合飼料B", unit: "袋" },
      { id: pId3, name: "ミネラル剤", unit: "kg" },
    ];

    const fId1 = uid(), fId2 = uid(), fId3 = uid(), fId4 = uid(), fId5 = uid();
    const farms = [
      { id: fId1, name: "山田牧場", region: "帯広地区", note: "", order: 0, nextVisitDate: null },
      { id: fId2, name: "鈴木牧場", region: "帯広地区", note: "", order: 1, nextVisitDate: dstr(2) },
      { id: fId3, name: "佐藤牧場", region: "音更地区", note: "搬入は裏口から", order: 0, nextVisitDate: null },
      { id: fId4, name: "田中牧場", region: "音更地区", note: "", order: 1, nextVisitDate: dstr(-3) },
      { id: fId5, name: "高橋牧場", region: "", note: "", order: 0, nextVisitDate: null },
    ];

    const stocks = [
      // 危険: 直近の使用量が速く、まもなく在庫切れ
      { id: uid(), farmId: fId1, productId: pId1, useManual: false, manualDailyUsage: null, plannedDeliveries: [],
        logs: [mkLog(-5, 26), mkLog(-1, 8)] },
      // 注意
      { id: uid(), farmId: fId1, productId: pId2, useManual: false, manualDailyUsage: null, plannedDeliveries: [],
        logs: [mkLog(-9, 26), mkLog(-3, 12)] },
      // 正常（余裕あり）
      { id: uid(), farmId: fId2, productId: pId1, useManual: false, manualDailyUsage: null, plannedDeliveries: [],
        logs: [mkLog(-14, 100), mkLog(-7, 90)] },
      // 手入力の使用量を使う例（記録が1件のみ）
      { id: uid(), farmId: fId2, productId: pId3, useManual: true, manualDailyUsage: 0.8, plannedDeliveries: [],
        logs: [mkLog(-5, 5)] },
      // 納品(残数増加)があった直後の例。直前の使用量を引き継いで計算される
      { id: uid(), farmId: fId3, productId: pId1, useManual: false, manualDailyUsage: null, plannedDeliveries: [],
        logs: [mkLog(-20, 100), mkLog(-13, 79), mkLog(-6, 150)] },
      // 使用量急増の例
      { id: uid(), farmId: fId3, productId: pId2, useManual: false, manualDailyUsage: null, plannedDeliveries: [],
        logs: [mkLog(-21, 120), mkLog(-10, 98), mkLog(-3, 74)] },
      // 使用量急減の例
      { id: uid(), farmId: fId4, productId: pId1, useManual: false, manualDailyUsage: null, plannedDeliveries: [],
        logs: [mkLog(-21, 100), mkLog(-10, 60), mkLog(-3, 52)] },
      // 納品予定の例
      { id: uid(), farmId: fId4, productId: pId2, useManual: false, manualDailyUsage: null,
        logs: [mkLog(-6, 30)], plannedDeliveries: [{ id: uid(), date: dstr(2), quantity: 50 }] },
      // 記録がまだない例
      { id: uid(), farmId: fId5, productId: pId3, useManual: false, manualDailyUsage: null, plannedDeliveries: [],
        logs: [] },
    ];

    save({ farms, products, stocks });
  };

  const addFarm = (name, note = "", region = "") => {
    if (!name.trim()) return;
    const regionKey = region.trim();
    const maxOrder = data.farms
      .filter((f) => (f.region || "") === regionKey)
      .reduce((m, f) => Math.max(m, f.order ?? 0), -1);
    save({
      ...data,
      farms: [...data.farms, { id: uid(), name: name.trim(), note: note.trim(), region: regionKey, order: maxOrder + 1 }],
    });
  };
  const addFarmsBulk = (list) => {
    const existingByKey = new Map(data.farms.map((f) => [f.name.trim().toLowerCase(), f]));
    const orderCounters = {};
    data.farms.forEach((f) => {
      const r = f.region || "";
      orderCounters[r] = Math.max(orderCounters[r] ?? -1, f.order ?? 0);
    });
    let addedCount = 0;
    let updatedCount = 0;
    const updates = new Map();
    const newFarms = [];
    list.forEach((item) => {
      const name = (item.name || "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      const note = (item.note || "").trim();
      const region = (item.region || "").trim();
      const existing = existingByKey.get(key);
      if (existing) {
        const patch = {};
        if (note && note !== existing.note) patch.note = note;
        if (region && region !== existing.region) patch.region = region;
        if (Object.keys(patch).length > 0) {
          updates.set(existing.id, { ...(updates.get(existing.id) || {}), ...patch });
          updatedCount++;
        }
        return;
      }
      orderCounters[region] = (orderCounters[region] ?? -1) + 1;
      const newFarm = { id: uid(), name, note, region, order: orderCounters[region] };
      newFarms.push(newFarm);
      existingByKey.set(key, newFarm);
      addedCount++;
    });
    if (newFarms.length > 0 || updates.size > 0) {
      save({
        ...data,
        farms: [
          ...data.farms.map((f) => (updates.has(f.id) ? { ...f, ...updates.get(f.id) } : f)),
          ...newFarms,
        ],
      });
    }
    return { added: addedCount, updated: updatedCount, skipped: list.length - addedCount - updatedCount };
  };
  // 農家を並び替える。newRegionが現在と異なる地域の場合は地域も変更する。
  // insertBeforeId が指定されればその農家の位置に挿入、nullなら地域の末尾に追加する。
  const moveFarm = (farmId, newRegion, insertBeforeId) => {
    const farm = data.farms.find((f) => f.id === farmId);
    if (!farm) return;
    const regionFarms = data.farms
      .filter((f) => f.id !== farmId && (f.region || "") === newRegion)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const ids = regionFarms.map((f) => f.id);
    const insertAt = insertBeforeId ? ids.indexOf(insertBeforeId) : -1;
    ids.splice(insertAt === -1 ? ids.length : insertAt, 0, farmId);
    const orderMap = new Map(ids.map((id, idx) => [id, idx]));
    save({
      ...data,
      farms: data.farms.map((f) => {
        if (f.id === farmId) return { ...f, region: newRegion, order: orderMap.get(farmId) };
        if (orderMap.has(f.id)) return { ...f, order: orderMap.get(f.id) };
        return f;
      }),
    });
  };
  const deleteFarm = (id) => {
    save({
      ...data,
      farms: data.farms.filter((f) => f.id !== id),
      stocks: data.stocks.filter((s) => s.farmId !== id),
    });
  };
  const updateFarmVisitDate = (farmId, date) => {
    save({
      ...data,
      farms: data.farms.map((f) => (f.id === farmId ? { ...f, nextVisitDate: date || null } : f)),
    });
  };
  const addProduct = (name, unit) => {
    if (!name.trim()) return;
    save({ ...data, products: [...data.products, { id: uid(), name: name.trim(), unit: unit.trim() || "個" }] });
  };
  const deleteProduct = (id) => {
    save({
      ...data,
      products: data.products.filter((p) => p.id !== id),
      stocks: data.stocks.filter((s) => s.productId !== id),
    });
  };
  const addStock = (farmId, productId, initialRemaining, initialDate) => {
    if (!farmId || !productId) return;
    const exists = data.stocks.find((s) => s.farmId === farmId && s.productId === productId);
    if (exists) return;
    const newStock = {
      id: uid(),
      farmId,
      productId,
      useManual: false,
      manualDailyUsage: null,
      logs: initialRemaining !== "" && initialRemaining != null
        ? [{ id: uid(), date: initialDate || todayStr(), remaining: Number(initialRemaining) }]
        : [],
    };
    save({ ...data, stocks: [...data.stocks, newStock] });
  };
  const deleteStock = (id) => {
    save({ ...data, stocks: data.stocks.filter((s) => s.id !== id) });
    if (selectedStockId === id) setSelectedStockId(null);
  };
  const addLog = (stockId, date, remaining) => {
    save({
      ...data,
      stocks: data.stocks.map((s) =>
        s.id === stockId
          ? { ...s, logs: [...s.logs, { id: uid(), date, remaining: Number(remaining) }] }
          : s
      ),
    });
  };
  const deleteLog = (stockId, logId) => {
    save({
      ...data,
      stocks: data.stocks.map((s) =>
        s.id === stockId ? { ...s, logs: s.logs.filter((l) => l.id !== logId) } : s
      ),
    });
  };
  const updateManual = (stockId, useManual, manualDailyUsage) => {
    save({
      ...data,
      stocks: data.stocks.map((s) =>
        s.id === stockId ? { ...s, useManual, manualDailyUsage } : s
      ),
    });
  };
  const addPlannedDelivery = (stockId, date, quantity) => {
    if (!date || quantity === "" || isNaN(Number(quantity))) return;
    save({
      ...data,
      stocks: data.stocks.map((s) =>
        s.id === stockId
          ? { ...s, plannedDeliveries: [...(s.plannedDeliveries || []), { id: uid(), date, quantity: Number(quantity) }] }
          : s
      ),
    });
  };
  const deletePlannedDelivery = (stockId, deliveryId) => {
    save({
      ...data,
      stocks: data.stocks.map((s) =>
        s.id === stockId
          ? { ...s, plannedDeliveries: (s.plannedDeliveries || []).filter((d) => d.id !== deliveryId) }
          : s
      ),
    });
  };
  const fulfillPlannedDelivery = (stockId, deliveryId, actualRemaining) => {
    if (actualRemaining === "" || isNaN(Number(actualRemaining))) return;
    save({
      ...data,
      stocks: data.stocks.map((s) => {
        if (s.id !== stockId) return s;
        const delivery = (s.plannedDeliveries || []).find((d) => d.id === deliveryId);
        if (!delivery) return s;
        return {
          ...s,
          logs: [...s.logs, { id: uid(), date: delivery.date, remaining: Number(actualRemaining) }],
          plannedDeliveries: s.plannedDeliveries.filter((d) => d.id !== deliveryId),
        };
      }),
    });
  };

  const productTotals = data.products.map((p) => {
    const items = enrichedStocks.filter((s) => s.productId === p.id);
    const total = items.reduce((sum, s) => sum + (s.latest?.remaining || 0), 0);
    return { ...p, total, count: items.length };
  });

  const selectedStock = enrichedStocks.find((s) => s.id === selectedStockId);

  return (
    <div
      style={{
        fontFamily: "'IBM Plex Sans JP', sans-serif",
        background: COLORS.bg,
        color: COLORS.text,
        minHeight: "100%",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <style>{`
        ${FONT_IMPORT}
        * { box-sizing: border-box; }
        ::selection { background: ${COLORS.steel}55; }
        .nav-btn { transition: color .15s, border-color .15s; }
        .row-card { transition: border-color .15s, transform .1s; }
        .row-card:hover { border-color: ${COLORS.steel}; }
        table { border-collapse: collapse; width: 100%; }
        th, td { text-align: left; padding: 8px 10px; font-size: 13px; }
        th { color: ${COLORS.textDim}; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid ${COLORS.border}; }
        td { border-bottom: 1px solid ${COLORS.border}44; }
        a { color: ${COLORS.steel}; }

        @media print {
          .no-print { display: none !important; }
          body, html { background: #fff !important; }
          .print-area {
            background: #fff !important;
            color: #111 !important;
          }
          .print-area * {
            color: #111 !important;
            background: transparent !important;
            border-color: #ccc !important;
          }
        }
      `}</style>

      {/* Header */}
      <div
        className="no-print"
        style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${COLORS.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: COLORS.panel,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 30, height: 30, borderRadius: 6, background: COLORS.sage,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <Gauge size={17} color="#11151B" />
          </div>
          <div>
            <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 17, fontWeight: 600, letterSpacing: 0.5 }}>
              FEED STOCK GAUGE
            </div>
            <div style={{ fontSize: 11, color: COLORS.textDim }}>飼料在庫管理</div>
          </div>
        </div>
        <nav style={{ display: "flex", gap: 4 }}>
          {[
            ["home", "ホーム", HomeIcon],
            ["weekly", "週間計画", CalendarDays],
            ["farms", "農家", Warehouse],
            ["products", "商品", Package],
            ["alerts", "アラート", AlertTriangle],
          ].map(([key, label, Icon]) => (
            <button
              key={key}
              className="nav-btn"
              onClick={() => { setTab(key); setSelectedStockId(null); }}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                background: "transparent", border: "none", cursor: "pointer",
                padding: "8px 12px", borderRadius: 5,
                color: tab === key ? COLORS.text : COLORS.textDim,
                borderBottom: tab === key ? `2px solid ${COLORS.sage}` : "2px solid transparent",
                fontSize: 13, fontWeight: 500,
              }}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </nav>
      </div>

      <div style={{ padding: 20 }}>
        {error && (
          <div style={{ color: COLORS.rust, fontSize: 12, marginBottom: 10 }}>{error}</div>
        )}

        {tab === "home" && !selectedStockId && (
          <>
            {data.farms.length === 0 && (
              <div style={{ marginBottom: 16, padding: 14, background: COLORS.panelAlt, border: `1px dashed ${COLORS.border}`, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <div style={{ fontSize: 13, color: COLORS.textDim }}>まだデータがありません。サンプルの農家・商品・在庫記録を追加して、画面のイメージを確認できます。</div>
                <Btn variant="primary" onClick={seedSampleData}><Plus size={14} /> サンプルデータを追加</Btn>
              </div>
            )}
            {data.farms.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <WeeklySummaryWidget
                  enrichedStocks={enrichedStocks}
                  farms={data.farms}
                  onOpenWeekly={() => setTab("weekly")}
                />
              </div>
            )}
            <HomeView
              enrichedStocks={sortedByUrgency}
              productTotals={productTotals}
              farmName={farmName}
              productInfo={productInfo}
              filterStatus={filterStatus}
              setFilterStatus={setFilterStatus}
              farms={data.farms}
              onUpdateVisitDate={updateFarmVisitDate}
              onSelect={(id) => { setSelectedStockId(id); setTab("detail"); }}
            />
          </>
        )}

        {tab === "detail" && selectedStock && (
          <DetailView
            stock={selectedStock}
            farmName={farmName(selectedStock.farmId)}
            product={productInfo(selectedStock.productId)}
            onBack={() => { setTab("home"); setSelectedStockId(null); }}
            onAddLog={addLog}
            onDeleteLog={deleteLog}
            onUpdateManual={updateManual}
            onDeleteStock={deleteStock}
            onAddPlannedDelivery={addPlannedDelivery}
            onDeletePlannedDelivery={deletePlannedDelivery}
            onFulfillPlannedDelivery={fulfillPlannedDelivery}
          />
        )}

        {tab === "farms" && (
          <FarmsView
            data={data}
            enrichedStocks={enrichedStocks}
            onAddFarm={addFarm}
            onAddFarmsBulk={addFarmsBulk}
            onDeleteFarm={deleteFarm}
            onMoveFarm={moveFarm}
            onUpdateVisitDate={updateFarmVisitDate}
            onAddStock={addStock}
            onDeleteStock={deleteStock}
            onSelect={(id) => { setSelectedStockId(id); setTab("detail"); }}
          />
        )}

        {tab === "products" && (
          <ProductsView
            data={data}
            enrichedStocks={enrichedStocks}
            farmName={farmName}
            onAddProduct={addProduct}
            onDeleteProduct={deleteProduct}
          />
        )}

        {tab === "weekly" && (
          <WeeklyPlanView
            enrichedStocks={enrichedStocks}
            farms={data.farms}
            productInfo={productInfo}
            onUpdateVisitDate={updateFarmVisitDate}
          />
        )}

        {tab === "alerts" && (
          <AlertsView
            items={alertItems}
            enrichedStocks={enrichedStocks}
            farmName={farmName}
            productInfo={productInfo}
            leadDays={leadDays}
            setLeadDays={setLeadDays}
            onSelect={(id) => { setSelectedStockId(id); setTab("detail"); }}
          />
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 7,
      padding: "14px 16px", flex: 1, minWidth: 130,
    }}>
      <div style={{ fontSize: 11, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 26, fontWeight: 600, color: color || COLORS.text, marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

function HomeView({ enrichedStocks, productTotals, farmName, productInfo, filterStatus, setFilterStatus, farms, onUpdateVisitDate, onSelect }) {
  const critical = enrichedStocks.filter((s) => s.status === "critical").length;
  const warning = enrichedStocks.filter((s) => s.status === "warning").length;
  const filtered = filterStatus === "all" ? enrichedStocks : enrichedStocks.filter((s) => s.status === filterStatus);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="危険 (3日以内)" value={critical} color={COLORS.rust} />
        <StatCard label="注意 (7日以内)" value={warning} color={COLORS.amber} />
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, letterSpacing: 0.5, color: COLORS.textDim, textTransform: "uppercase" }}>
            農家全体の在庫状況（切れそうな順）
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {["all", "critical", "warning", "ok", "unknown"].map((k) => (
              <button
                key={k}
                onClick={() => setFilterStatus(k)}
                style={{
                  fontSize: 11, padding: "4px 9px", borderRadius: 4, cursor: "pointer",
                  background: filterStatus === k ? COLORS.panelAlt : "transparent",
                  border: `1px solid ${COLORS.border}`, color: COLORS.textDim,
                }}
              >
                {k === "all" ? "すべて" : STATUS_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.length === 0 && <Empty text="該当する在庫アイテムがありません" />}
          {filtered.map((s) => (
            <div
              key={s.id}
              className="row-card"
              onClick={() => onSelect(s.id)}
              style={{
                background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 7,
                padding: "12px 16px", display: "flex", alignItems: "center", gap: 16, cursor: "pointer",
              }}
            >
              <div style={{ width: 140, flexShrink: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{farmName(s.farmId)}</div>
                <div style={{ fontSize: 12, color: COLORS.textDim }}>{productInfo(s.productId).name}</div>
              </div>
              <div style={{ flex: 1 }}><Gauge_ daysLeft={s.daysLeft} status={s.status} /></div>
              <div style={{ width: 100, textAlign: "right" }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: COLORS.textDim }}>
                  {s.latest ? `${Math.round(s.projectedRemaining)}${productInfo(s.productId).unit}` : "記録なし"}
                </div>
                {s.latest && <div style={{ fontSize: 10, color: COLORS.textDim }}>本日予想</div>}
              </div>
              <div style={{ width: 150, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                <VisitDateCell
                  farm={farms.find((f) => f.id === s.farmId)}
                  onUpdateVisitDate={onUpdateVisitDate}
                  stockoutDate={s.stockoutDate}
                />
              </div>
              <div style={{ width: 90, display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                <StatusBadge status={s.status} />
                <TrendBadge trend={s.trend} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Empty({ text }) {
  return (
    <div style={{ color: COLORS.textDim, fontSize: 13, padding: "16px 0", fontStyle: "italic" }}>{text}</div>
  );
}

function DetailView({ stock, farmName, product, onBack, onAddLog, onDeleteLog, onUpdateManual, onDeleteStock, onAddPlannedDelivery, onDeletePlannedDelivery, onFulfillPlannedDelivery }) {
  const [date, setDate] = useState(todayStr());
  const [remaining, setRemaining] = useState("");
  const [manualInput, setManualInput] = useState(stock.manualDailyUsage ?? "");
  const [useManual, setUseManualLocal] = useState(stock.useManual);

  const logs = sortedLogs(stock);
  const chartData = logs.map((l) => ({ date: fmtDate(l.date), remaining: l.remaining, full: l.date }));
  if (stock.stockoutDate) {
    chartData.push({ date: fmtDate(stock.stockoutDate), remaining: 0, full: stock.stockoutDate, projected: true });
  }

  const submitLog = () => {
    if (remaining === "" || isNaN(Number(remaining))) return;
    onAddLog(stock.id, date, remaining);
    setRemaining("");
  };

  const submitManual = () => {
    onUpdateManual(stock.id, useManual, manualInput === "" ? null : Number(manualInput));
  };

  const calendarLink = stock.stockoutDate
    ? gcalUrl(
        `【在庫アラート】${farmName} / ${product.name}`,
        stock.stockoutDate,
        `在庫が切れる見込みです。早めの納品をご検討ください。（自動計算: 1日${stock.usage.value ? stock.usage.value.toFixed(2) : "?"}${product.unit}使用）`
      )
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={onBack} style={{ background: "transparent", border: "none", color: COLORS.textDim, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}>
          <ChevronLeft size={16} /> ホームに戻る
        </button>
        <Btn variant="danger" onClick={() => { if (confirm("この在庫アイテムを削除しますか？")) onDeleteStock(stock.id); }}>
          <Trash2 size={13} /> このアイテムを削除
        </Btn>
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12, color: COLORS.textDim }}>{farmName}</div>
          <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 24, fontWeight: 600 }}>{product.name}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <StatusBadge status={stock.status} />
          <TrendBadge trend={stock.trend} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="現在の残数" value={stock.latest ? `${stock.latest.remaining}${product.unit}` : "―"} />
        <StatCard
          label="1日の使用量"
          value={stock.usage.value ? `${stock.usage.value.toFixed(2)}${product.unit}` : "―"}
          color={stock.usage.source === "manual" ? COLORS.steel : COLORS.text}
        />
        <StatCard
          label="月あたりの使用量"
          value={stock.usage.value ? `${(stock.usage.value * 30).toFixed(1)}${product.unit}` : "―"}
          color={stock.usage.source === "manual" ? COLORS.steel : COLORS.text}
        />
        <StatCard label="在庫切れ予測日" value={stock.stockoutDate ? fmtDateFull(stock.stockoutDate) : "―"} color={STATUS_COLOR[stock.status]} />
      </div>
      {stock.trend?.direction && (
        <div style={{ fontSize: 12, color: COLORS.textDim, marginTop: -10 }}>
          前回の使用量 {stock.trend.previous.toFixed(2)}{product.unit}/日 → 今回 {stock.trend.current.toFixed(2)}{product.unit}/日
          （{stock.trend.direction === "up" ? "増加" : "減少"}。{stock.trend.direction === "down" ? "頭数減少や離反の可能性があるので訪問時に確認をおすすめします。" : "増頭など追加提案のチャンスかもしれません。"}）
        </div>
      )}

      {chartData.length >= 2 && (
        <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: 14, height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke={COLORS.textDim} tick={{ fontSize: 11 }} />
              <YAxis stroke={COLORS.textDim} tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={{ background: COLORS.panelAlt, border: `1px solid ${COLORS.border}`, fontSize: 12 }} />
              <Line type="monotone" dataKey="remaining" stroke={COLORS.sage} strokeWidth={2} dot={{ r: 3 }} />
              {stock.stockoutDate && (
                <ReferenceDot x={fmtDate(stock.stockoutDate)} y={0} r={5} fill={COLORS.rust} stroke="none" />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Panel title="残数を記録する">
          <div style={{ display: "flex", gap: 8 }}>
            <Field label="日付">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
            </Field>
            <Field label={`残数 (${product.unit})`}>
              <input type="number" value={remaining} onChange={(e) => setRemaining(e.target.value)} style={inputStyle} placeholder="例: 40" />
            </Field>
          </div>
          <Btn variant="primary" onClick={submitLog} style={{ marginTop: 10 }}>
            <Plus size={14} /> 記録を追加
          </Btn>
          <div style={{ marginTop: 14 }}>
            <table>
              <thead><tr><th>日付</th><th>残数</th><th></th></tr></thead>
              <tbody>
                {logs.slice().reverse().map((l) => (
                  <tr key={l.id}>
                    <td>{fmtDateFull(l.date)}</td>
                    <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{l.remaining}{product.unit}</td>
                    <td>
                      <button onClick={() => onDeleteLog(stock.id, l.id)} style={{ background: "transparent", border: "none", color: COLORS.textDim, cursor: "pointer" }}>
                        <X size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
                {logs.length === 0 && (
                  <tr><td colSpan={3} style={{ color: COLORS.textDim, fontStyle: "italic" }}>記録がありません</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="1日の使用量を手入力">
          <div style={{ fontSize: 12, color: COLORS.textDim, marginBottom: 10, lineHeight: 1.5 }}>
            通常は直近2件の記録から自動算出されます。納品直後などで自動算出が合わない場合は、手入力の値を優先できます。
          </div>
          <Field label={`1日あたりの使用量 (${product.unit}/日)`}>
            <input type="number" value={manualInput} onChange={(e) => setManualInput(e.target.value)} style={inputStyle} placeholder="例: 3.5" />
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 10, fontSize: 12, color: COLORS.textDim, cursor: "pointer" }}>
            <input type="checkbox" checked={useManual} onChange={(e) => setUseManualLocal(e.target.checked)} />
            自動計算より手入力の値を優先する
          </label>
          <Btn onClick={submitManual} style={{ marginTop: 10 }}><Settings2 size={13} /> 設定を保存</Btn>

          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${COLORS.border}` }}>
            <div style={{ fontSize: 12, color: COLORS.textDim, marginBottom: 8 }}>在庫切れ予測日をカレンダーに追加</div>
            {calendarLink ? (
              <a href={calendarLink} target="_blank" rel="noopener noreferrer">
                <Btn variant="primary"><CalendarPlus size={14} /> Googleカレンダーに追加</Btn>
              </a>
            ) : (
              <div style={{ fontSize: 12, color: COLORS.textDim, fontStyle: "italic" }}>予測に必要な記録がまだありません</div>
            )}
          </div>
        </Panel>
      </div>

      <PlannedDeliveryPanel
        stock={stock}
        product={product}
        onAddPlannedDelivery={onAddPlannedDelivery}
        onDeletePlannedDelivery={onDeletePlannedDelivery}
        onFulfillPlannedDelivery={onFulfillPlannedDelivery}
      />
    </div>
  );
}

function PlannedDeliveryPanel({ stock, product, onAddPlannedDelivery, onDeletePlannedDelivery, onFulfillPlannedDelivery }) {
  const [date, setDate] = useState(todayStr());
  const [quantity, setQuantity] = useState("");
  const [fulfillingId, setFulfillingId] = useState(null);
  const [fulfillValue, setFulfillValue] = useState("");

  const deliveries = [...(stock.plannedDeliveries || [])].sort((a, b) => a.date.localeCompare(b.date));

  const startFulfill = (delivery) => {
    const projected = projectRemainingOnDate(stock, delivery.date);
    const suggested = projected != null ? Math.round((projected + delivery.quantity) * 10) / 10 : delivery.quantity;
    setFulfillingId(delivery.id);
    setFulfillValue(String(suggested));
  };

  return (
    <Panel title="納品予定">
      <div style={{ fontSize: 12, color: COLORS.textDim, marginBottom: 10, lineHeight: 1.5 }}>
        今後の納品予定を登録しておくと、納品が完了したときにワンタップで残数記録を作成できます。
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Field label="納品予定日">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        </Field>
        <Field label={`納品予定数 (${product.unit})`}>
          <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} style={inputStyle} placeholder="例: 50" />
        </Field>
        <Btn variant="primary" onClick={() => { onAddPlannedDelivery(stock.id, date, quantity); setQuantity(""); }} style={{ alignSelf: "flex-end" }}>
          <Plus size={13} /> 予定を追加
        </Btn>
      </div>

      {deliveries.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          {deliveries.map((d) => (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "8px 0", borderBottom: `1px solid ${COLORS.border}44` }}>
              <div style={{ width: 100 }}>{fmtDateFull(d.date)}</div>
              <div style={{ width: 90, fontFamily: "'IBM Plex Mono', monospace" }}>{d.quantity}{product.unit}</div>
              {fulfillingId === d.id ? (
                <>
                  <Field label={`納品後の残数 (${product.unit})`}>
                    <input type="number" value={fulfillValue} onChange={(e) => setFulfillValue(e.target.value)} style={{ ...inputStyle, width: 110 }} />
                  </Field>
                  <Btn variant="primary" onClick={() => { onFulfillPlannedDelivery(stock.id, d.id, fulfillValue); setFulfillingId(null); }} style={{ alignSelf: "flex-end" }}>
                    確定
                  </Btn>
                  <button onClick={() => setFulfillingId(null)} style={{ background: "transparent", border: "none", color: COLORS.textDim, cursor: "pointer", alignSelf: "flex-end", marginBottom: 8 }}>
                    キャンセル
                  </button>
                </>
              ) : (
                <>
                  <Btn onClick={() => startFulfill(d)}><Check size={13} /> 納品完了として記録</Btn>
                  <button onClick={() => onDeletePlannedDelivery(stock.id, d.id)} style={{ background: "transparent", border: "none", color: COLORS.textDim, cursor: "pointer" }}>
                    <X size={13} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Panel({ title, children }) {
  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: 16 }}>
      <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 13, letterSpacing: 0.5, textTransform: "uppercase", color: COLORS.textDim, marginBottom: 12 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function FarmsView({ data, enrichedStocks, onAddFarm, onAddFarmsBulk, onDeleteFarm, onMoveFarm, onUpdateVisitDate, onAddStock, onDeleteStock, onSelect }) {
  const [newFarm, setNewFarm] = useState("");
  const [newRegion, setNewRegion] = useState("");
  const [openFarmId, setOpenFarmId] = useState(null);
  const [productSel, setProductSel] = useState("");
  const [initRemaining, setInitRemaining] = useState("");
  const [initDate, setInitDate] = useState(todayStr());
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [dragOverRegion, setDragOverRegion] = useState(null);

  const grouped = useMemo(() => {
    const map = new Map();
    data.farms.forEach((f) => {
      const region = (f.region || "").trim() || "地域未設定";
      if (!map.has(region)) map.set(region, []);
      map.get(region).push(f);
    });
    map.forEach((list) => list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
    const regions = Array.from(map.keys()).sort((a, b) => {
      if (a === "地域未設定") return 1;
      if (b === "地域未設定") return -1;
      return a.localeCompare(b, "ja");
    });
    return regions.map((region) => ({ region, farms: map.get(region) }));
  }, [data.farms]);

  const toActualRegion = (regionKey) => (regionKey === "地域未設定" ? "" : regionKey);

  const resetDrag = () => { setDraggedId(null); setDragOverId(null); setDragOverRegion(null); };

  const performDrop = () => {
    if (!draggedId) { resetDrag(); return; }
    if (dragOverId && dragOverId !== draggedId) {
      const targetGroup = grouped.find((g) => g.farms.some((f) => f.id === dragOverId));
      if (targetGroup) {
        onMoveFarm(draggedId, toActualRegion(targetGroup.region), dragOverId);
      }
    } else if (dragOverRegion) {
      onMoveFarm(draggedId, toActualRegion(dragOverRegion), null);
    }
    resetDrag();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Panel title="農家を追加">
        <div style={{ display: "flex", gap: 8 }}>
          <input value={newFarm} onChange={(e) => setNewFarm(e.target.value)} placeholder="農家名（例: 山田牧場）" style={{ ...inputStyle, flex: 2 }} />
          <input value={newRegion} onChange={(e) => setNewRegion(e.target.value)} placeholder="地域（例: 帯広地区）" style={{ ...inputStyle, flex: 1 }} />
          <Btn variant="primary" onClick={() => { onAddFarm(newFarm, "", newRegion); setNewFarm(""); setNewRegion(""); }}><Plus size={14} /> 追加</Btn>
        </div>
      </Panel>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {data.farms.length === 0 && <Empty text="農家が登録されていません" />}
        {grouped.map(({ region, farms }) => {
          const isRegionDragOver = dragOverRegion === region && !dragOverId;
          return (
          <div
            key={region}
            data-region={region}
            style={{
              borderRadius: 7,
              outline: isRegionDragOver ? `1px dashed ${COLORS.steel}` : "none",
              outlineOffset: 4,
            }}
          >
            <div style={{
              fontFamily: "'Oswald', sans-serif", fontSize: 13, letterSpacing: 0.5, textTransform: "uppercase",
              color: COLORS.textDim, marginBottom: 8, display: "flex", alignItems: "center", gap: 8,
            }}>
              {region} <span style={{ fontSize: 11, color: COLORS.textDim, fontWeight: 400, textTransform: "none" }}>（{farms.length}軒）</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: farms.length === 0 ? 40 : undefined }}>
              {farms.length === 0 && (
                <div style={{ fontSize: 11, color: COLORS.textDim, fontStyle: "italic", padding: "8px 0" }}>
                  （ここに農家をドラッグして移動できます）
                </div>
              )}
              {farms.map((f) => {
                const items = enrichedStocks.filter((s) => s.farmId === f.id);
                const open = openFarmId === f.id;
                const isDragOver = dragOverId === f.id && draggedId !== f.id;
                return (
                  <div
                    key={f.id}
                    data-farm-id={f.id}
                    style={{
                      background: COLORS.panel,
                      border: `1px solid ${isDragOver ? COLORS.steel : COLORS.border}`,
                      borderRadius: 7, padding: 14,
                      opacity: draggedId === f.id ? 0.4 : 1,
                      transition: "border-color .1s, opacity .1s",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          onPointerDown={(e) => {
                            e.preventDefault();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            setDraggedId(f.id);
                          }}
                          onPointerMove={(e) => {
                            if (draggedId !== f.id) return;
                            const el = document.elementFromPoint(e.clientX, e.clientY);
                            const rowEl = el?.closest("[data-farm-id]");
                            if (rowEl) {
                              const overId = rowEl.getAttribute("data-farm-id");
                              setDragOverId((cur) => (cur === overId ? cur : overId));
                              setDragOverRegion(null);
                            } else {
                              const regionEl = el?.closest("[data-region]");
                              if (regionEl) {
                                const overRegion = regionEl.getAttribute("data-region");
                                setDragOverRegion((cur) => (cur === overRegion ? cur : overRegion));
                                setDragOverId(null);
                              }
                            }
                          }}
                          onPointerUp={(e) => {
                            e.currentTarget.releasePointerCapture(e.pointerId);
                            performDrop();
                          }}
                          onPointerCancel={resetDrag}
                          style={{ cursor: "grab", color: COLORS.textDim, display: "flex", touchAction: "none" }}
                        >
                          <GripVertical size={15} />
                        </span>
                        <div onClick={() => setOpenFarmId(open ? null : f.id)} style={{ cursor: "pointer" }}>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>
                            {f.name} <span style={{ color: COLORS.textDim, fontSize: 12, fontWeight: 400 }}>（{items.length}品目）</span>
                          </div>
                          {f.note && <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 2 }}>{f.note}</div>}
                          {(() => {
                            const earliestStockout = items
                              .map((i) => i.stockoutDate)
                              .filter(Boolean)
                              .sort()[0];
                            const hasCritical = items.some((i) => i.status === "critical" || i.status === "warning");
                            if (f.nextVisitDate) {
                              const mismatch = earliestStockout && earliestStockout < f.nextVisitDate;
                              return (
                                <div style={{ fontSize: 11, marginTop: 2, color: mismatch ? COLORS.rust : COLORS.textDim, display: "flex", alignItems: "center", gap: 4 }}>
                                  <CalendarCheck size={11} /> 次回訪問: {fmtDateFull(f.nextVisitDate)}
                                  {mismatch && " (訪問予定より先に在庫切れの可能性)"}
                                </div>
                              );
                            }
                            if (hasCritical) {
                              return (
                                <div style={{ fontSize: 11, marginTop: 2, color: COLORS.amber }}>
                                  訪問予定日が未設定です
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      </div>
                      <Btn
                        variant="danger"
                        draggable={false}
                        onClick={() => { if (confirm(`${f.name} を削除しますか？関連する在庫データも削除されます。`)) onDeleteFarm(f.id); }}
                      >
                        <Trash2 size={13} />
                      </Btn>
                    </div>
                    {open && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <Field label="次回訪問予定日">
                            <input
                              type="date"
                              value={f.nextVisitDate || ""}
                              onChange={(e) => onUpdateVisitDate(f.id, e.target.value)}
                              style={{ ...inputStyle, width: 160 }}
                            />
                          </Field>
                          {f.nextVisitDate && (
                            <button onClick={() => onUpdateVisitDate(f.id, "")} style={{ background: "transparent", border: "none", color: COLORS.textDim, cursor: "pointer", fontSize: 12, marginTop: 16 }}>
                              クリア
                            </button>
                          )}
                        </div>
                        {items.map((s) => {
                          const p = data.products.find((pp) => pp.id === s.productId);
                          return (
                            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
                              <div style={{ width: 110 }}>{p?.name}</div>
                              <div style={{ flex: 1 }}><Gauge_ daysLeft={s.daysLeft} status={s.status} /></div>
                              <StatusBadge status={s.status} />
                              <button onClick={() => onSelect(s.id)} style={{ background: "transparent", border: "none", color: COLORS.steel, cursor: "pointer", fontSize: 12 }}>詳細</button>
                              <button onClick={() => onDeleteStock(s.id)} style={{ background: "transparent", border: "none", color: COLORS.textDim, cursor: "pointer" }}><X size={13} /></button>
                            </div>
                          );
                        })}
                        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                          <select value={productSel} onChange={(e) => setProductSel(e.target.value)} style={{ ...inputStyle, flex: 1 }}>
                            <option value="">商品を選択して追加...</option>
                            {data.products.filter((p) => !items.some((i) => i.productId === p.id)).map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                          <input type="number" placeholder="初期残数(任意)" value={initRemaining} onChange={(e) => setInitRemaining(e.target.value)} style={{ ...inputStyle, width: 130 }} />
                          <input type="date" value={initDate} onChange={(e) => setInitDate(e.target.value)} style={{ ...inputStyle, width: 140 }} />
                          <Btn variant="primary" onClick={() => { onAddStock(f.id, productSel, initRemaining, initDate); setProductSel(""); setInitRemaining(""); setInitDate(todayStr()); }}>
                            <Plus size={13} /> 割当
                          </Btn>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          );
        })}
      </div>

      <CsvImportPanel onImport={onAddFarmsBulk} />

      <CsvExportPanel data={data} enrichedStocks={enrichedStocks} />
    </div>
  );
}

function CsvExportPanel({ data, enrichedStocks }) {
  const exportFarms = () => {
    const rows = data.farms.map((f) => [f.name, f.region || "", f.note || "", f.nextVisitDate || ""]);
    downloadCsv("farms.csv", ["農家名", "地域", "メモ", "次回訪問予定日"], rows);
  };

  const exportLogs = () => {
    const farmName = (id) => data.farms.find((f) => f.id === id)?.name || "";
    const productInfo = (id) => data.products.find((p) => p.id === id) || { name: "", unit: "" };
    const rows = [];
    enrichedStocks.forEach((s) => {
      const p = productInfo(s.productId);
      (s.logs || []).forEach((l) => {
        rows.push([farmName(s.farmId), p.name, p.unit, l.date, l.remaining]);
      });
    });
    downloadCsv("stock-logs.csv", ["農家名", "商品名", "単位", "日付", "残数"], rows);
  };

  return (
    <Panel title="データをCSVでエクスポート">
      <div style={{ fontSize: 12, color: COLORS.textDim, marginBottom: 10, lineHeight: 1.6 }}>
        バックアップやExcelでの分析用に、登録データをCSVファイルとして書き出せます。
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn onClick={exportFarms}><FileDown size={14} /> 農家一覧をエクスポート</Btn>
        <Btn onClick={exportLogs}><FileDown size={14} /> 残数記録の全履歴をエクスポート</Btn>
      </div>
    </Panel>
  );
}

function CsvImportPanel({ onImport }) {
  const [rows, setRows] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [nameCol, setNameCol] = useState("");
  const [noteCol, setNoteCol] = useState("");
  const [regionCol, setRegionCol] = useState("");
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState(null);
  const [parseError, setParseError] = useState("");

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setParseError("");
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => {
          if (!res.data || res.data.length === 0) {
            setParseError("データを読み取れませんでした。1行目に見出し行があるCSVを指定してください。");
            setHeaders([]);
            setRows([]);
            return;
          }
          const fields = res.meta.fields || [];
          setHeaders(fields);
          setRows(res.data);
          const guessName = fields.find((h) => /名|farm|name|顧客|牧場/i.test(h));
          const guessRegion = fields.find((h) => /地域|エリア|region|area|地区/i.test(h));
          setNameCol(guessName || fields[0] || "");
          setRegionCol(guessRegion || "");
          setNoteCol("");
        },
        error: () => setParseError("CSVの解析に失敗しました。ファイルの形式を確認してください。"),
      });
    };
    reader.readAsText(file, "UTF-8");
  };

  const preview = rows.slice(0, 5);

  const handleImport = () => {
    if (!nameCol) return;
    const list = rows.map((r) => ({
      name: r[nameCol],
      note: noteCol ? r[noteCol] : "",
      region: regionCol ? r[regionCol] : "",
    }));
    const count = onImport(list);
    setResult(count);
  };

  return (
    <Panel title="CSVから顧客リストを取り込む">
      <div style={{ fontSize: 12, color: COLORS.textDim, marginBottom: 10, lineHeight: 1.6 }}>
        農家名の列を含むCSVファイルを選択してください（1行目は見出し）。取り込み時に列を選べます。既に登録済みの農家名（完全一致）は重複登録されません。
      </div>
      <input type="file" accept=".csv" onChange={handleFile} style={{ fontSize: 12, color: COLORS.textDim }} />
      {parseError && <div style={{ color: COLORS.rust, fontSize: 12, marginTop: 8 }}>{parseError}</div>}
      {headers.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Field label="農家名の列（必須）">
              <select value={nameCol} onChange={(e) => { setNameCol(e.target.value); setResult(null); }} style={inputStyle}>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>
            <Field label="地域の列（任意）">
              <select value={regionCol} onChange={(e) => { setRegionCol(e.target.value); setResult(null); }} style={inputStyle}>
                <option value="">（なし）</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>
            <Field label="メモ列（任意・住所や電話番号など）">
              <select value={noteCol} onChange={(e) => { setNoteCol(e.target.value); setResult(null); }} style={inputStyle}>
                <option value="">（なし）</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ fontSize: 12, color: COLORS.textDim }}>{fileName} : {rows.length}件を検出</div>
          <table>
            <thead><tr><th>農家名</th><th>地域</th><th>メモ</th></tr></thead>
            <tbody>
              {preview.map((r, i) => (
                <tr key={i}>
                  <td>{r[nameCol] || "―"}</td>
                  <td>{regionCol ? (r[regionCol] || "―") : "―"}</td>
                  <td>{noteCol ? (r[noteCol] || "―") : "―"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 5 && (
            <div style={{ fontSize: 11, color: COLORS.textDim }}>...他 {rows.length - 5}件</div>
          )}
          <Btn variant="primary" onClick={handleImport} style={{ alignSelf: "flex-start" }}>
            <Plus size={14} /> {rows.length}件をインポート
          </Btn>
          {result != null && (
            <div style={{ fontSize: 12, color: COLORS.sage }}>
              新規追加 {result.added}件 / 情報更新 {result.updated}件 / 変更なし {result.skipped}件
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function getMondayOf(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay(); // 0=日,1=月,...6=土
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function WeeklySummaryWidget({ enrichedStocks, farms, onOpenWeekly }) {
  const monday = useMemo(() => getMondayOf(todayStr()), []);
  const weekDates = useMemo(() => [0, 1, 2, 3, 4].map((i) => addDaysStr(monday, i)), [monday]);
  const dayLabels = ["月", "火", "水", "木", "金"];
  const friday = weekDates[4];

  const farmSummaries = useMemo(() => {
    const map = new Map();
    enrichedStocks.forEach((s) => {
      if (!map.has(s.farmId)) map.set(s.farmId, []);
      map.get(s.farmId).push(s);
    });
    return Array.from(map.entries())
      .map(([farmId, items]) => {
        const farm = farms.find((f) => f.id === farmId);
        const stockoutDates = items.map((i) => i.stockoutDate).filter(Boolean).sort();
        return { farmId, farm, earliestStockout: stockoutDates[0] || null };
      })
      .filter((s) => s.farm);
  }, [enrichedStocks, farms]);

  const countPerDay = weekDates.map((date) => farmSummaries.filter(({ farm }) => farm.nextVisitDate === date).length);
  const unassignedCount = farmSummaries.filter(({ farm, earliestStockout }) => {
    const inThisWeek = farm.nextVisitDate && weekDates.includes(farm.nextVisitDate);
    if (inThisWeek) return false;
    const needsThisWeek = earliestStockout && earliestStockout <= friday;
    const overdue = farm.nextVisitDate && farm.nextVisitDate < monday;
    return needsThisWeek || overdue;
  }).length;

  return (
    <div
      onClick={onOpenWeekly}
      style={{
        cursor: "pointer", background: COLORS.panel, border: `1px solid ${COLORS.border}`,
        borderRadius: 7, padding: 14,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, color: COLORS.textDim, textTransform: "uppercase" }}>
          今週の配送計画
        </div>
        <div style={{ fontSize: 11, color: COLORS.steel }}>週間計画を開く →</div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {weekDates.map((date, i) => {
          const isToday = date === todayStr();
          return (
            <div
              key={date}
              style={{
                flex: "1 1 60px", textAlign: "center", padding: "8px 4px", borderRadius: 5,
                background: isToday ? `${COLORS.sage}22` : COLORS.panelAlt,
                border: `1px solid ${isToday ? COLORS.sage : COLORS.border}`,
              }}
            >
              <div style={{ fontSize: 11, color: COLORS.textDim }}>{dayLabels[i]}{isToday && "・本日"}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 18, fontWeight: 600 }}>{countPerDay[i]}</div>
            </div>
          );
        })}
        {unassignedCount > 0 && (
          <div style={{ flex: "1 1 70px", textAlign: "center", padding: "8px 4px", borderRadius: 5, background: `${COLORS.rust}18`, border: `1px solid ${COLORS.rust}66` }}>
            <div style={{ fontSize: 11, color: COLORS.rust }}>未割当</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 18, fontWeight: 600, color: COLORS.rust }}>{unassignedCount}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function WeeklyPlanView({ enrichedStocks, farms, productInfo, onUpdateVisitDate }) {
  const [weekOffset, setWeekOffset] = useState(0);

  const monday = useMemo(() => addDaysStr(getMondayOf(todayStr()), weekOffset * 7), [weekOffset]);
  const weekDates = useMemo(() => [0, 1, 2, 3, 4].map((i) => addDaysStr(monday, i)), [monday]);
  const dayLabels = ["月", "火", "水", "木", "金"];
  const friday = weekDates[4];
  const isThisWeek = weekOffset === 0;

  const farmSummaries = useMemo(() => {
    const map = new Map();
    enrichedStocks.forEach((s) => {
      if (!map.has(s.farmId)) map.set(s.farmId, []);
      map.get(s.farmId).push(s);
    });
    return Array.from(map.entries()).map(([farmId, items]) => {
      const farm = farms.find((f) => f.id === farmId);
      const stockoutDates = items.map((i) => i.stockoutDate).filter(Boolean).sort();
      const earliestStockout = stockoutDates[0] || null;
      const rank = { critical: 0, warning: 1, unknown: 2, ok: 3 };
      const worstStatus = items.reduce((worst, i) => (rank[i.status] < rank[worst] ? i.status : worst), "ok");
      return { farmId, farm, items, earliestStockout, worstStatus };
    }).filter((s) => s.farm);
  }, [enrichedStocks, farms]);

  const unassigned = farmSummaries.filter(({ farm, earliestStockout }) => {
    const inThisWeek = farm.nextVisitDate && weekDates.includes(farm.nextVisitDate);
    if (inThisWeek) return false;
    if (!isThisWeek) return false; // 未割当リストは「今週」表示時のみ意味を持つ
    const needsThisWeek = earliestStockout && earliestStockout <= friday;
    const overdue = farm.nextVisitDate && farm.nextVisitDate < monday;
    return needsThisWeek || overdue;
  }).sort((a, b) => (a.earliestStockout || "9999").localeCompare(b.earliestStockout || "9999"));

  const byDay = weekDates.map((date) => ({
    date,
    items: farmSummaries.filter(({ farm }) => farm.nextVisitDate === date),
  }));

  const scheduledCount = byDay.reduce((sum, d) => sum + d.items.length, 0);

  const handleExportWeekIcs = () => {
    const icsItems = [];
    byDay.forEach(({ date, items }) => {
      items.forEach(({ farm, items: farmItems }) => {
        icsItems.push({
          alertDate: date,
          title: `【配送予定】${farm.name}`,
          details: farmItems.map((i) => productInfo(i.productId).name).join("・"),
        });
      });
    });
    if (icsItems.length === 0) return;
    downloadIcs(icsItems);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 16, fontWeight: 600 }}>
          {fmtDateFull(monday)} 〜 {fmtDateFull(friday)} の配送計画
          {isThisWeek && <span style={{ fontSize: 11, color: COLORS.sage, marginLeft: 8 }}>今週</span>}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Btn onClick={() => setWeekOffset((w) => w - 1)}>← 前週</Btn>
          <Btn onClick={() => setWeekOffset(0)}>今週</Btn>
          <Btn onClick={() => setWeekOffset((w) => w + 1)}>翌週 →</Btn>
          <Btn variant="primary" onClick={handleExportWeekIcs} disabled={scheduledCount === 0}>
            <Download size={14} /> この週の予定をカレンダーに一括登録（{scheduledCount}件）
          </Btn>
        </div>
      </div>
      <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: -8 }}>
        ボタンを押すと .ics ファイルがダウンロードされます。Googleカレンダーの設定から「インポート」を選び、そのファイルを選択すると、この週に割り当てた農家の予定がまとめて登録されます。
      </div>

      {isThisWeek && (
        <Panel title={`未割当（今週中の対応が必要 / ${unassigned.length}件）`}>
          {unassigned.length === 0 ? (
            <Empty text="今週中に対応が必要な農家はすべて割り当て済みです" />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {unassigned.map(({ farmId, farm, items, earliestStockout, worstStatus }) => (
                <div key={farmId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: COLORS.panelAlt, borderRadius: 6, flexWrap: "wrap" }}>
                  <StatusBadge status={worstStatus} />
                  <div style={{ fontWeight: 600, fontSize: 13, minWidth: 110 }}>{farm.name}</div>
                  <div style={{ fontSize: 11, color: COLORS.textDim, flex: 1 }}>
                    {items.map((i) => productInfo(i.productId).name).join("・")}
                    {earliestStockout && ` ／ 予測: ${fmtDateFull(earliestStockout)}`}
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {dayLabels.map((label, i) => (
                      <button
                        key={label}
                        onClick={() => onUpdateVisitDate(farmId, weekDates[i])}
                        style={{ fontSize: 11, padding: "4px 8px", borderRadius: 4, cursor: "pointer", background: "transparent", border: `1px solid ${COLORS.border}`, color: COLORS.text }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {byDay.map(({ date, items }) => (
          <div key={date} style={{ flex: "1 1 180px", minWidth: 180, background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: 12 }}>
            <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 13, marginBottom: 8, color: date === todayStr() ? COLORS.sage : COLORS.text }}>
              {dayLabels[weekDates.indexOf(date)]}曜日 <span style={{ fontSize: 11, color: COLORS.textDim, fontWeight: 400 }}>{fmtDate(date)}</span>
              {date === todayStr() && <span style={{ fontSize: 10, color: COLORS.sage, marginLeft: 6 }}>本日</span>}
            </div>
            {items.length === 0 ? (
              <div style={{ fontSize: 11, color: COLORS.textDim, fontStyle: "italic" }}>予定なし</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {items.map(({ farmId, farm, items: farmItems, worstStatus }) => (
                  <div key={farmId} style={{ background: COLORS.panelAlt, borderRadius: 5, padding: "7px 9px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{farm.name}</span>
                      <StatusBadge status={worstStatus} />
                    </div>
                    <div style={{ fontSize: 10, color: COLORS.textDim, marginTop: 2 }}>
                      {farmItems.map((i) => productInfo(i.productId).name).join("・")}
                    </div>
                    <button
                      onClick={() => onUpdateVisitDate(farmId, "")}
                      style={{ fontSize: 10, color: COLORS.textDim, background: "transparent", border: "none", cursor: "pointer", marginTop: 4, padding: 0 }}
                    >
                      未割当に戻す
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductsView({ data, enrichedStocks, farmName, onAddProduct, onDeleteProduct }) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("袋");
  const [openProductId, setOpenProductId] = useState(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Panel title="商品を追加">
        <div style={{ display: "flex", gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="商品名（例: 配合飼料A）" style={{ ...inputStyle, flex: 2 }} />
          <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="単位" style={{ ...inputStyle, width: 90 }} />
          <Btn variant="primary" onClick={() => { onAddProduct(name, unit); setName(""); }}><Plus size={14} /> 追加</Btn>
        </div>
      </Panel>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data.products.length === 0 && <Empty text="商品が登録されていません" />}
        {data.products.map((p) => {
          const open = openProductId === p.id;
          const stocksForProduct = enrichedStocks.filter((s) => s.productId === p.id);
          return (
            <div key={p.id} style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: "10px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div onClick={() => setOpenProductId(open ? null : p.id)} style={{ cursor: "pointer" }}>
                  <span style={{ fontWeight: 600 }}>{p.name}</span> <span style={{ color: COLORS.textDim, fontSize: 12 }}>（単位: {p.unit}）</span>
                  <span style={{ color: COLORS.steel, fontSize: 12, marginLeft: 8 }}>{open ? "▲ 閉じる" : "▼ 分析を見る"}</span>
                </div>
                <Btn variant="danger" onClick={() => { if (confirm(`${p.name} を削除しますか？関連する在庫データも削除されます。`)) onDeleteProduct(p.id); }}>
                  <Trash2 size={13} />
                </Btn>
              </div>
              {open && (
                <ProductAnalysis product={p} stocksForProduct={stocksForProduct} farmName={farmName} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProductAnalysis({ product, stocksForProduct, farmName }) {
  const ranking = useMemo(() => {
    return [...stocksForProduct]
      .filter((s) => s.usage.value != null)
      .sort((a, b) => b.usage.value - a.usage.value);
  }, [stocksForProduct]);

  const monthly = useMemo(() => computeMonthlyConsumption(stocksForProduct), [stocksForProduct]);

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 12, color: COLORS.textDim, marginBottom: 8, textTransform: "uppercase" }}>
          農家別消費量ランキング
        </div>
        {ranking.length === 0 ? (
          <Empty text="使用量を算出できる記録がありません" />
        ) : (
          <table>
            <thead><tr><th>順位</th><th>農家</th><th>1日の使用量</th><th>月あたりの使用量</th><th>現在の残数</th><th>残日数</th></tr></thead>
            <tbody>
              {ranking.map((s, i) => (
                <tr key={s.id}>
                  <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{i + 1}</td>
                  <td>{farmName(s.farmId)}</td>
                  <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{s.usage.value.toFixed(2)}{product.unit}/日</td>
                  <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{(s.usage.value * 30).toFixed(1)}{product.unit}/月</td>
                  <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{s.latest ? `${s.latest.remaining}${product.unit}` : "―"}</td>
                  <td><StatusBadge status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 12, color: COLORS.textDim, marginBottom: 8, textTransform: "uppercase" }}>
          月別消費量の推移（全農家合計）
        </div>
        {monthly.length === 0 ? (
          <Empty text="集計できる記録がまだありません" />
        ) : (
          <div style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthly}>
                <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" />
                <XAxis dataKey="month" stroke={COLORS.textDim} tick={{ fontSize: 11 }} />
                <YAxis stroke={COLORS.textDim} tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: COLORS.panelAlt, border: `1px solid ${COLORS.border}`, fontSize: 12 }}
                  formatter={(v) => [`${v}${product.unit}`, "消費量"]}
                />
                <Bar dataKey="total" fill={COLORS.sage} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <div style={{ fontSize: 10, color: COLORS.textDim, marginTop: 4 }}>
          ※ 記録の間隔をもとにした概算値です（消費量は記録した日の月に計上しています）
        </div>
      </div>
    </div>
  );
}

function AlertsView({ items, enrichedStocks, farmName, productInfo, leadDays, setLeadDays, onSelect }) {
  const urgentForCalendar = items.filter((s) => s.stockoutDate);

  const upcomingDeliveries = useMemo(() => {
    const list = [];
    enrichedStocks.forEach((s) => {
      (s.plannedDeliveries || []).forEach((d) => {
        list.push({ ...d, stockId: s.id, farmId: s.farmId, productId: s.productId });
      });
    });
    return list.sort((a, b) => a.date.localeCompare(b.date));
  }, [enrichedStocks]);

  const handleBulkIcs = () => {
    const icsItems = urgentForCalendar.map((s) => {
      const alertDate = new Date(s.stockoutDate);
      alertDate.setDate(alertDate.getDate() - leadDays);
      const useDate = alertDate < new Date() ? s.stockoutDate : alertDate.toISOString().slice(0, 10);
      return {
        alertDate: useDate,
        title: `【在庫アラート】${farmName(s.farmId)} / ${productInfo(s.productId).name}`,
        details: `在庫切れ予測日: ${fmtDateFull(s.stockoutDate)}`,
      };
    });
    if (icsItems.length === 0) return;
    downloadIcs(icsItems);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Panel title="アラート設定">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Field label="在庫切れの何日前に通知するか">
            <input type="number" value={leadDays} onChange={(e) => setLeadDays(Number(e.target.value))} style={{ ...inputStyle, width: 80 }} />
          </Field>
          <Btn onClick={handleBulkIcs} style={{ marginTop: 18 }}>
            <Download size={14} /> 対象アイテムを .ics で一括書き出し
          </Btn>
        </div>
        <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 10, lineHeight: 1.6 }}>
          ※ このアプリからGoogleカレンダーへ直接・自動でイベントを作成することはできません（要OAuth連携）。
          各アイテムの「Googleカレンダーに追加」ボタンでは、Googleカレンダーの予定作成画面を開いて内容を自動入力するので、開いた画面で保存を押すだけで登録できます。
          まとめて登録したい場合は上の .ics 書き出しをGoogleカレンダーにインポートしてください。
        </div>
      </Panel>

      {upcomingDeliveries.length > 0 && (
        <Panel title="今後の納品予定">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {upcomingDeliveries.map((d) => (
              <div
                key={d.id}
                onClick={() => onSelect(d.stockId)}
                style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 13, cursor: "pointer", padding: "6px 0", borderBottom: `1px solid ${COLORS.border}44` }}
              >
                <div style={{ width: 100, fontFamily: "'IBM Plex Mono', monospace" }}>{fmtDateFull(d.date)}</div>
                <div style={{ width: 140 }}>{farmName(d.farmId)}</div>
                <div style={{ flex: 1, color: COLORS.textDim }}>{productInfo(d.productId).name}</div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{d.quantity}{productInfo(d.productId).unit}</div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.length === 0 && <Empty text="直近で在庫切れが近いアイテムはありません" />}
        {items.map((s) => {
          const product = productInfo(s.productId);
          const link = s.stockoutDate
            ? gcalUrl(`【在庫アラート】${farmName(s.farmId)} / ${product.name}`, s.stockoutDate, `在庫切れ予測日: ${fmtDateFull(s.stockoutDate)}`)
            : null;
          return (
            <div key={s.id} style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: "12px 16px", display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 150 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{farmName(s.farmId)}</div>
                <div style={{ fontSize: 12, color: COLORS.textDim }}>{product.name}</div>
              </div>
              <div style={{ flex: 1 }}><Gauge_ daysLeft={s.daysLeft} status={s.status} /></div>
              <div style={{ fontSize: 12, color: COLORS.textDim, width: 110 }}>
                予測: {s.stockoutDate ? fmtDateFull(s.stockoutDate) : "―"}
              </div>
              <StatusBadge status={s.status} />
              {link && (
                <a href={link} target="_blank" rel="noopener noreferrer">
                  <Btn variant="primary"><CalendarPlus size={13} /> 追加</Btn>
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
