const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();
const session = require("express-session");
const multer = require("multer");
const PDFDocument = require("pdfkit");

const app = express();
const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(ROOT, "data.db");
const UPLOAD_DIR = path.join(ROOT, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password || "")).digest("hex");
}

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(value) {
  if (!value) return "";
  const d = new Date(value.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function deletePhotoFile(fileName) {
  if (!fileName) return;
  const filePath = path.join(UPLOAD_DIR, fileName);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error("删除照片失败:", err.message);
    }
  }
}

function generateProductCode(callback) {
  const now = new Date();
  const prefix =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");

  db.get(
    "SELECT productCode FROM products WHERE productCode LIKE ? ORDER BY productCode DESC LIMIT 1",
    [`${prefix}%`],
    (err, row) => {
      if (err) return callback(err);
      let seq = 1;
      if (row && row.productCode) {
        const last = parseInt(String(row.productCode).slice(-3), 10);
        if (!isNaN(last)) seq = last + 1;
      }
      callback(null, prefix + String(seq).padStart(3, "0"));
    }
  );
}

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function generateWeeklySummaryPdf(callback) {
  const now = new Date();
  const day = now.getDay();
  const end = new Date(now);
  end.setDate(now.getDate() - day + 6);
  end.setHours(23, 59, 59, 999);

  const start = new Date(end);
  start.setDate(end.getDate() - 6);
  start.setHours(0, 0, 0, 0);

  const startStr = start.toISOString().slice(0, 19).replace("T", " ");
  const endStr = end.toISOString().slice(0, 19).replace("T", " ");

  db.all(
    `
    SELECT 
      u.id AS userId,
      u.username,
      COUNT(p.id) AS totalAdded,
      SUM(CASE WHEN p.approveStatus='approved' THEN 1 ELSE 0 END) AS totalApproved
    FROM users u
    LEFT JOIN products p
      ON u.id = p.ownerUserId
      AND p.createdAt BETWEEN ? AND ?
    WHERE u.is_admin = 0
    GROUP BY u.id, u.username
    ORDER BY u.username
    `,
    [startStr, endStr],
    async (err, rows) => {
      if (err) return callback(err);

      const pdfName = `weekly-summary-${Date.now()}.pdf`;
      const pdfPath = path.join(ROOT, pdfName);
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      doc.fontSize(20).text("每周产品汇总", { align: "center" });
      doc.moveDown();

      for (const [index, row] of (rows || []).entries()) {
        const totalAdded = Number(row.totalAdded || 0);
        const totalApproved = Number(row.totalApproved || 0);
        const rate = totalAdded ? ((totalApproved / totalAdded) * 100).toFixed(2) + "%" : "0%";
        const approvedList = await allAsync(
          `SELECT productName FROM products 
           WHERE ownerUserId=? AND approveStatus='approved' AND createdAt BETWEEN ? AND ?`,
          [row.userId, startStr, endStr]
        );
        const names = approvedList.map(x => x.productName).filter(Boolean).join("、") || "无";

        doc.fontSize(14).text(`用户${index + 1}：${row.username}`);
        doc.text(`增加产品表单数量：${totalAdded}`);
        doc.text(`通过数量：${totalApproved}`);
        doc.text(`通过百分比：${rate}`);
        doc.text(`通过的产品：${names}`);
        doc.moveDown();
      }

      doc.end();

      stream.on("finish", () => {
        db.run(
          `INSERT INTO weekly_reports (weekStart, weekEnd, pdfPath, createdBy)
           VALUES (?, ?, ?, ?)`,
          [startStr, endStr, pdfName, "system"],
          (e) => callback(e, pdfName)
        );
      });
    }
  );
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_plain TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      approval_status TEXT DEFAULT 'pending',
      approved_by TEXT,
      approved_at TEXT,
      reject_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT,
      last_edit_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formName TEXT,
      productName TEXT,
      productCode TEXT,
      exchangeRate TEXT,
      purchaseCost TEXT,
      commissionRate TEXT,
      fenxiaoPrice TEXT,
      adRate TEXT,
      profitCostDiff TEXT,
      profitRate1 TEXT,
      sellingPriceUsd TEXT,
      sellingPriceRmb TEXT,
      profitSellDiff TEXT,
      profitRate2 TEXT,
      remark TEXT,
      packageType TEXT,
      volumeWeight6000 TEXT,
      volumeWeight5000 TEXT,
      actualWeight TEXT,
      lengthCm TEXT,
      widthCm TEXT,
      heightCm TEXT,
      expressFee TEXT,
      expressProfit TEXT,
      expressProfitRate TEXT,
      airFee TEXT,
      airProfit TEXT,
      airProfitRate TEXT,
      seaFee TEXT,
      seaProfit TEXT,
      seaProfitRate TEXT,
      expressWeightQty TEXT,
      expressUnitPrice TEXT,
      expressTax TEXT,
      expressTotalPrice TEXT,
      airWeightQty TEXT,
      airUnitPrice TEXT,
      airTax TEXT,
      airTotalPrice TEXT,
      seaWeightQty TEXT,
      seaUnitPrice TEXT,
      seaTax TEXT,
      seaTotalPrice TEXT,
      fbaFeeRmb TEXT,
      commissionRmb TEXT,
      returnCostRmb TEXT,
      warehouseUsd TEXT,
      deliveryUsd TEXT,
      adCostRmb TEXT,
      approveStatus TEXT DEFAULT 'pending',
      approvedBy TEXT,
      approvedAt TEXT,
      rejectReason TEXT,
      competitor1Name TEXT,
      competitor1Link TEXT,
      competitor1Image TEXT,
      competitor1Price TEXT,
      competitor2Name TEXT,
      competitor2Link TEXT,
      competitor2Image TEXT,
      competitor2Price TEXT,
      competitor3Name TEXT,
      competitor3Link TEXT,
      competitor3Image TEXT,
      competitor3Price TEXT,
      changedFields TEXT,
      photoPath TEXT,
      ownerUserId INTEGER,
      ownerUsername TEXT,
      lastEditedByUserId INTEGER,
      lastEditedByUsername TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS weekly_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      weekStart TEXT,
      weekEnd TEXT,
      pdfPath TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      createdBy TEXT
    )
  `);

  db.get("SELECT * FROM users WHERE username = ?", ["gly123"], (err, row) => {
    if (err) return console.error(err);
    if (!row) {
      db.run(
        `INSERT INTO users
         (username, password_hash, password_plain, is_admin, approval_status, approved_by, approved_at)
         VALUES (?, ?, ?, 1, 'approved', 'system', datetime('now','localtime'))`,
        ["gly123", hashPassword("6604"), "6604"]
      );
    } else {
      db.run(
        `UPDATE users
         SET is_admin = 1,
             approval_status='approved',
             approved_by='system',
             approved_at=COALESCE(approved_at, datetime('now','localtime'))
         WHERE username=?`,
        ["gly123"]
      );
    }
  });
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(ROOT));
app.use("/uploads", express.static(UPLOAD_DIR));

app.use(
  session({
    secret: "product-development-record-sheet-secret",
    resave: false,
    saveUninitialized: false
  })
);

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname || "") || ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const upload = multer({ storage });

function checkLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function checkAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.status(403).send("只有管理员可以访问");
  }
  next();
}

function blueBtn(href, text) {
  return `<a href="${href}" style="
    display:inline-block;
    background:#2f6fed;
    color:#fff;
    text-decoration:none;
    padding:10px 16px;
    border-radius:4px;
    margin-right:10px;
    font-size:14px;
  ">${text}</a>`;
}

function renderTopButtons(user) {
  return `
    <div style="margin-bottom:20px;">
      ${blueBtn("/form", "新增表单")}
      ${blueBtn("/list", "产品列表")}
      ${user && user.is_admin ? blueBtn("/users", "查看用户") : ""}
      ${blueBtn("/logout", "退出登录")}
      ${user && user.is_admin ? blueBtn("/inbox", "收件箱") : ""}
    </div>
  `;
}

function renderLoginPage(message = "") {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <title>Product Development Record Sheet - Login</title>
    <style>
      body{margin:0;background:#fff;font-family:Arial,"Microsoft YaHei",sans-serif;}
      .wrap{width:420px;margin:90px auto;border:1px solid #d9d9d9;border-radius:10px;padding:30px;background:#fff;box-sizing:border-box;}
      input{width:100%;box-sizing:border-box;padding:12px;margin-top:12px;border:1px solid #cfcfcf;}
      button{width:100%;margin-top:18px;height:44px;border:none;background:#2f6fed;color:#fff;cursor:pointer;font-size:16px;}
      .msg{color:#c62828;margin-top:10px;}
      .line{margin-top:18px;text-align:center;}
      a{text-decoration:none;color:#2f6fed;}
      h1{text-align:center;}
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Product Development Record Sheet</h1>
      ${message ? `<div class="msg">${esc(message)}</div>` : ""}
      <form method="POST" action="/login">
        <input name="username" placeholder="用户名" required />
        <input type="password" name="password" placeholder="密码" required />
        <button type="submit">登录</button>
      </form>
      <div class="line"><a href="/register">注册账户</a></div>
    </div>
  </body>
  </html>`;
}

function renderRegisterPage(message = "") {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <title>Product Development Record Sheet - Register</title>
    <style>
      body{margin:0;background:#fff;font-family:Arial,"Microsoft YaHei",sans-serif;}
      .wrap{width:420px;margin:90px auto;border:1px solid #d9d9d9;border-radius:10px;padding:30px;background:#fff;box-sizing:border-box;}
      input{width:100%;box-sizing:border-box;padding:12px;margin-top:12px;border:1px solid #cfcfcf;}
      button{width:100%;margin-top:18px;height:44px;border:none;background:#2f6fed;color:#fff;cursor:pointer;font-size:16px;}
      .msg{color:#c62828;margin-top:10px;}
      .line{margin-top:18px;text-align:center;}
      a{text-decoration:none;color:#2f6fed;}
      h1{text-align:center;}
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>注册账户</h1>
      ${message ? `<div class="msg">${esc(message)}</div>` : ""}
      <form method="POST" action="/register">
        <input name="username" placeholder="自定义用户名" required />
        <input type="password" name="password" placeholder="自定义密码" required />
        <button type="submit">注册</button>
      </form>
      <div class="line"><a href="/login">返回登录</a></div>
    </div>
  </body>
  </html>`;
}

function fieldInput(label, name, value = "", extraClass = "", extraAttr = "") {
  return `
    <tr>
      <td class="label">${label}</td>
      <td><input class="input ${extraClass}" name="${name}" id="${name}" value="${esc(value)}" ${extraAttr}></td>
    </tr>
  `;
}

function renderFormPage({ mode, user, row = {} }) {
  const isEdit = mode === "edit";
  const action = isEdit ? `/update/${row.id}` : "/save";
  const title = isEdit ? "编辑表单" : "新增表单";
  const photoHtml = row.photoPath
    ? `<img src="/uploads/${esc(row.photoPath)}" style="max-width:100%;max-height:100%;object-fit:contain;">`
    : `<div class="photo-inner">ⓘ<span>暂无照片</span></div>`;

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;background:#fff;color:#222;}
    .topbar{background:#fff;border-bottom:1px solid #d0d0d0;padding:12px 16px;font-size:22px;font-weight:bold;}
    .page{width:1380px;margin:8px auto 30px auto;background:#fff;border:1px solid #bdbdbd;}
    .button-area{padding:16px;border-bottom:1px solid #d0d0d0;background:#fff;}
    .section-title{background:#a8a8a8;color:#fff;font-size:20px;padding:10px 14px;font-weight:bold;}
    table.layout{width:100%;border-collapse:collapse;table-layout:fixed;font-size:14px;}
    table.layout td, table.layout th{border:1px solid #8f8f8f;padding:6px 8px;vertical-align:middle;background:#efefef;}
    .label{width:180px;text-align:right;background:#e3e3e3 !important;white-space:nowrap;}
    .input,.textarea{width:100%;box-sizing:border-box;height:32px;border:1px solid #9a9a9a;background:#f8f8f8;padding:4px 8px;font-size:14px;}
    .textarea{height:90px;resize:vertical;padding-top:6px;}
    .readonly-red{border:1px solid #ff6b6b;background:#ededed;color:#222;}
    .readonly-gray{border:1px solid #d8d8d8;background:#f7f7f7;color:#222;}
    .photo-box{height:300px;background:#f5f5f5;border:1px solid #b3b3b3;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:44px;overflow:hidden;}
    .photo-inner{text-align:center;}
    .photo-inner span{display:block;font-size:18px;margin-top:8px;color:#bbb;}
    .upload-row{margin-top:10px;font-size:13px;color:#444;display:flex;gap:16px;align-items:center;flex-wrap:wrap;}
    .submit-wrap{padding:14px;background:#d8d8d8;border-top:1px solid #8f8f8f;}
    .submit-btn{width:100%;height:42px;background:#2f6fed;border:none;color:#fff;font-size:16px;cursor:pointer;}
    .small-btn{display:inline-block;padding:6px 10px;background:#2f6fed;color:#fff !important;text-decoration:none;border-radius:3px;font-size:13px;border:none;cursor:pointer;}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:0;}
  </style>
</head>
<body>
  <div class="topbar">Product Development Record Sheet</div>
  <div class="page">
    <div class="button-area">
      ${renderTopButtons(user)}
      ${isEdit ? `<span style="font-size:13px;color:#444;">创建人：${esc(row.ownerUsername || "")} ｜ 最后编辑人：${esc(row.lastEditedByUsername || "")} ｜ 创建时间：${esc(formatTime(row.createdAt))} ｜ 最后更新时间：${esc(formatTime(row.updatedAt))}</span>` : ""}
    </div>

    <form method="POST" action="${action}" enctype="multipart/form-data" id="productForm">
      <div class="section-title">基础信息</div>
      <table class="layout">
        <colgroup>
          <col style="width:390px">
          <col style="width:180px">
          <col style="width:320px">
          <col style="width:180px">
          <col style="width:310px">
        </colgroup>
        <tr>
          <td rowspan="8" style="vertical-align:top;background:#efefef;">
            <div class="photo-box" id="photoPreviewBox">${photoHtml}</div>
            <div class="upload-row">
              <label class="small-btn" for="photoInput">上传照片</label>
              <input id="photoInput" type="file" name="photo" accept="image/*" style="display:none;">
              <a href="javascript:void(0)" id="deletePhotoBtn" style="color:#d32f2f;text-decoration:none;">删除照片</a>
            </div>
          </td>
          <td class="label">产品名称*</td>
          <td><input class="input" name="productName" id="productName" value="${esc(row.productName || "")}"></td>
          <td class="label">产品编号</td>
          <td><input class="input readonly-gray" name="productCode" id="productCode" value="${esc(row.productCode || "自动生成")}" readonly></td>
        </tr>
        <tr>
          <td class="label">汇率</td>
          <td>
            <div style="display:flex;gap:8px;">
              <input class="input calc" type="number" step="0.0001" name="exchangeRate" id="exchangeRate" value="${esc(row.exchangeRate || "")}">
              <button type="button" class="small-btn" style="width:110px;" onclick="fetchRate()">刷新汇率</button>
            </div>
          </td>
          <td class="label">采购成本(RMB)*</td>
          <td><input class="input calc" type="number" step="0.001" name="purchaseCost" id="purchaseCost" value="${esc(row.purchaseCost || "")}"></td>
        </tr>
        <tr>
          <td class="label">佣金(%)</td>
          <td><input class="input calc" type="number" step="0.001" name="commissionRate" id="commissionRate" value="${esc(row.commissionRate || "15")}"></td>
          <td class="label">分销价*</td>
          <td><input class="input calc" type="number" step="0.001" name="fenxiaoPrice" id="fenxiaoPrice" value="${esc(row.fenxiaoPrice || "")}"></td>
        </tr>
        <tr>
          <td class="label">广告费(%)</td>
          <td><input class="input calc" type="number" step="0.001" name="adRate" id="adRate" value="${esc(row.adRate || "15")}"></td>
          <td class="label">销售价(USD)*</td>
          <td><input class="input calc" type="number" step="0.001" name="sellingPriceUsd" id="sellingPriceUsd" value="${esc(row.sellingPriceUsd || "")}"></td>
        </tr>
        <tr>
          <td class="label">分销减采购成本利润</td>
          <td><input class="input readonly-red" name="profitCostDiff" id="profitCostDiff" value="${esc(row.profitCostDiff || "")}" readonly></td>
          <td class="label">利润率1(%)</td>
          <td><input class="input readonly-red" name="profitRate1" id="profitRate1" value="${esc(row.profitRate1 || "")}" readonly></td>
        </tr>
        <tr>
          <td class="label">销售价(RMB)</td>
          <td><input class="input readonly-red" name="sellingPriceRmb" id="sellingPriceRmb" value="${esc(row.sellingPriceRmb || "")}" readonly></td>
          <td class="label">销售价-分销价利润</td>
          <td><input class="input readonly-red" name="profitSellDiff" id="profitSellDiff" value="${esc(row.profitSellDiff || "")}" readonly></td>
        </tr>
        <tr>
          <td class="label">利润率2(%)</td>
          <td><input class="input readonly-red" name="profitRate2" id="profitRate2" value="${esc(row.profitRate2 || "")}" readonly></td>
          <td class="label">备注</td>
          <td rowspan="2"><textarea class="textarea" name="remark" id="remark">${esc(row.remark || "")}</textarea></td>
        </tr>
        <tr>
          <td class="label">表单名称</td>
          <td><input class="input" name="formName" id="formName" value="${esc(row.formName || "")}"></td>
        </tr>
      </table>

      <div class="section-title">包装与物流</div>
      <div class="grid2">
        <table class="layout">
          ${fieldInput("包装方式*", "packageType", row.packageType || "")}
          ${fieldInput("长(cm)", "lengthCm", row.lengthCm || "", "calc", 'type="number" step="0.001"')}
          ${fieldInput("宽(cm)", "widthCm", row.widthCm || "", "calc", 'type="number" step="0.001"')}
          ${fieldInput("高(cm)", "heightCm", row.heightCm || "", "calc", 'type="number" step="0.001"')}
          ${fieldInput("实际重量(KG)", "actualWeight", row.actualWeight || "", "calc", 'type="number" step="0.001"')}
          ${fieldInput("体积重1/6000", "volumeWeight6000", row.volumeWeight6000 || "", "readonly-red", "readonly")}
          ${fieldInput("体积重2/5000", "volumeWeight5000", row.volumeWeight5000 || "", "readonly-red", "readonly")}
          ${fieldInput("仓租(USD)", "warehouseUsd", row.warehouseUsd || "", "calc", 'type="number" step="0.001"')}
          ${fieldInput("配送(USD)", "deliveryUsd", row.deliveryUsd || "", "calc", 'type="number" step="0.001"')}
          ${fieldInput("退货成本(RMB)", "returnCostRmb", row.returnCostRmb || "", "calc", 'type="number" step="0.001"')}
          ${fieldInput("FBA费(RMB)", "fbaFeeRmb", row.fbaFeeRmb || "", "readonly-red", "readonly")}
          ${fieldInput("佣金(RMB)", "commissionRmb", row.commissionRmb || "", "readonly-red", "readonly")}
          ${fieldInput("广告费(RMB)", "adCostRmb", row.adCostRmb || "", "readonly-red", "readonly")}
        </table>

        <table class="layout">
          ${fieldInput("快递计重数量", "expressWeightQty", row.expressWeightQty || "", "readonly-red", "readonly")}
          ${fieldInput("快递单价", "expressUnitPrice", row.expressUnitPrice || "", "calc", 'type="number" step="0.001"')}
          ${fieldInput("快递税费", "expressTax", row.expressTax || "1", "calc", 'type="number" step="0.001"')}
          ${fieldInput("快递总价", "expressTotalPrice", row.expressTotalPrice || "", "readonly-red", "readonly")}
          ${fieldInput("快递总成本", "expressFee", row.expressFee || "", "readonly-red", "readonly")}
          ${fieldInput("快递利润", "expressProfit", row.expressProfit || "", "readonly-red", "readonly")}
          ${fieldInput("快递利润率", "expressProfitRate", row.expressProfitRate || "", "readonly-red", "readonly")}
          ${fieldInput("空运计重数量", "airWeightQty", row.airWeightQty || "", "readonly-red", "readonly")}
          ${fieldInput("空运单价", "airUnitPrice", row.airUnitPrice || "", "calc", 'type="number" step="0.001"')}
          ${fieldInput("空运税费", "airTax", row.airTax || "1", "calc", 'type="number" step="0.001"')}
          ${fieldInput("空运总价", "airTotalPrice", row.airTotalPrice || "", "readonly-red", "readonly")}
          ${fieldInput("空运总成本", "airFee", row.airFee || "", "readonly-red", "readonly")}
          ${fieldInput("空运利润", "airProfit", row.airProfit || "", "readonly-red", "readonly")}
          ${fieldInput("空运利润率", "airProfitRate", row.airProfitRate || "", "readonly-red", "readonly")}
          ${fieldInput("海运计重数量", "seaWeightQty", row.seaWeightQty || "", "readonly-red", "readonly")}
          ${fieldInput("海运单价", "seaUnitPrice", row.seaUnitPrice || "", "calc", 'type="number" step="0.001"')}
          ${fieldInput("海运税费", "seaTax", row.seaTax || "1", "calc", 'type="number" step="0.001"')}
          ${fieldInput("海运总价", "seaTotalPrice", row.seaTotalPrice || "", "readonly-red", "readonly")}
          ${fieldInput("海运总成本", "seaFee", row.seaFee || "", "readonly-red", "readonly")}
          ${fieldInput("海运利润", "seaProfit", row.seaProfit || "", "readonly-red", "readonly")}
          ${fieldInput("海运利润率", "seaProfitRate", row.seaProfitRate || "", "readonly-red", "readonly")}
        </table>
      </div>

      <div class="section-title">竞品信息</div>
      <table class="layout">
        <colgroup>
          <col style="width:160px"><col><col style="width:160px"><col>
        </colgroup>
        <tr>
          <td class="label">竞品1名称</td><td><input class="input" name="competitor1Name" id="competitor1Name" value="${esc(row.competitor1Name || "")}"></td>
          <td class="label">竞品1价格</td><td><input class="input" name="competitor1Price" id="competitor1Price" value="${esc(row.competitor1Price || "")}"></td>
        </tr>
        <tr>
          <td class="label">竞品1链接</td><td colspan="3"><input class="input" name="competitor1Link" id="competitor1Link" value="${esc(row.competitor1Link || "")}"></td>
        </tr>
        <tr>
          <td class="label">竞品2名称</td><td><input class="input" name="competitor2Name" id="competitor2Name" value="${esc(row.competitor2Name || "")}"></td>
          <td class="label">竞品2价格</td><td><input class="input" name="competitor2Price" id="competitor2Price" value="${esc(row.competitor2Price || "")}"></td>
        </tr>
        <tr>
          <td class="label">竞品2链接</td><td colspan="3"><input class="input" name="competitor2Link" id="competitor2Link" value="${esc(row.competitor2Link || "")}"></td>
        </tr>
        <tr>
          <td class="label">竞品3名称</td><td><input class="input" name="competitor3Name" id="competitor3Name" value="${esc(row.competitor3Name || "")}"></td>
          <td class="label">竞品3价格</td><td><input class="input" name="competitor3Price" id="competitor3Price" value="${esc(row.competitor3Price || "")}"></td>
        </tr>
        <tr>
          <td class="label">竞品3链接</td><td colspan="3"><input class="input" name="competitor3Link" id="competitor3Link" value="${esc(row.competitor3Link || "")}"></td>
        </tr>
      </table>

      <div class="submit-wrap">
        <button class="submit-btn" type="submit">${isEdit ? "保存修改" : "提交"}</button>
      </div>
    </form>
  </div>

<script>
function $(id){ return document.getElementById(id); }

function num(id){
  const el = $(id);
  if (!el) return 0;
  const v = parseFloat(el.value);
  return isNaN(v) ? 0 : v;
}

function setVal(id, val, digits = 3){
  const el = $(id);
  if (!el) return;
  if (val === "" || val === null || val === undefined || isNaN(val)) {
    el.value = "";
  } else {
    el.value = Number(val).toFixed(digits);
  }
}

function calcAll(){
  const exchangeRate = num("exchangeRate");
  const purchaseCost = num("purchaseCost");
  const commissionRate = num("commissionRate");
  const fenxiaoPrice = num("fenxiaoPrice");
  const adRate = num("adRate");
  const sellingPriceUsd = num("sellingPriceUsd");

  const lengthCm = num("lengthCm");
  const widthCm = num("widthCm");
  const heightCm = num("heightCm");
  const actualWeight = num("actualWeight");

  const expressUnitPrice = num("expressUnitPrice");
  const airUnitPrice = num("airUnitPrice");
  const seaUnitPrice = num("seaUnitPrice");

  const expressTax = num("expressTax") || 1;
  const airTax = num("airTax") || 1;
  const seaTax = num("seaTax") || 1;

  const warehouseUsd = num("warehouseUsd");
  const deliveryUsd = num("deliveryUsd");
  const returnCostRmb = num("returnCostRmb");

  const volumeWeight6000 = lengthCm * widthCm * heightCm / 6000;
  const volumeWeight5000 = lengthCm * widthCm * heightCm / 5000;

  setVal("volumeWeight6000", volumeWeight6000);
  setVal("volumeWeight5000", volumeWeight5000);

  const sellingPriceRmb = sellingPriceUsd * exchangeRate;
  const profitCostDiff = fenxiaoPrice - purchaseCost;
  const profitRate1 = purchaseCost ? (profitCostDiff / purchaseCost) * 100 : 0;
  const profitSellDiff = sellingPriceRmb - fenxiaoPrice;
  const profitRate2 = fenxiaoPrice ? (profitSellDiff / fenxiaoPrice) * 100 : 0;

  setVal("sellingPriceRmb", sellingPriceRmb);
  setVal("profitCostDiff", profitCostDiff);
  setVal("profitRate1", profitRate1);
  setVal("profitSellDiff", profitSellDiff);
  setVal("profitRate2", profitRate2);

  const expressWeightQty = Math.max(actualWeight, volumeWeight6000);
  const airWeightQty = Math.max(actualWeight, volumeWeight6000);
  const seaWeightQty = Math.max(actualWeight, volumeWeight5000);

  setVal("expressWeightQty", expressWeightQty);
  setVal("airWeightQty", airWeightQty);
  setVal("seaWeightQty", seaWeightQty);

  const expressTotalPrice = expressWeightQty * expressUnitPrice * expressTax;
  const airTotalPrice = airWeightQty * airUnitPrice * airTax;
  const seaTotalPrice = seaWeightQty * seaUnitPrice * seaTax;

  setVal("expressTotalPrice", expressTotalPrice);
  setVal("airTotalPrice", airTotalPrice);
  setVal("seaTotalPrice", seaTotalPrice);

  const commissionRmb = sellingPriceUsd * (commissionRate / 100) * exchangeRate;
  const adCostRmb = sellingPriceUsd * (adRate / 100) * exchangeRate;
  const fbaFeeRmb = (warehouseUsd + deliveryUsd) * exchangeRate;

  setVal("commissionRmb", commissionRmb);
  setVal("adCostRmb", adCostRmb);
  setVal("fbaFeeRmb", fbaFeeRmb);

  const expressFee = expressTotalPrice + fbaFeeRmb + commissionRmb + returnCostRmb + adCostRmb;
  const airFee = airTotalPrice + fbaFeeRmb + commissionRmb + returnCostRmb + adCostRmb;
  const seaFee = seaTotalPrice + fbaFeeRmb + commissionRmb + returnCostRmb + adCostRmb;

  setVal("expressFee", expressFee);
  setVal("airFee", airFee);
  setVal("seaFee", seaFee);

  const expressProfit = sellingPriceRmb - purchaseCost - expressFee;
  const airProfit = sellingPriceRmb - purchaseCost - airFee;
  const seaProfit = sellingPriceRmb - purchaseCost - seaFee;

  setVal("expressProfit", expressProfit);
  setVal("airProfit", airProfit);
  setVal("seaProfit", seaProfit);

  const expressProfitRate = sellingPriceRmb ? (expressProfit / sellingPriceRmb) * 100 : 0;
  const airProfitRate = sellingPriceRmb ? (airProfit / sellingPriceRmb) * 100 : 0;
  const seaProfitRate = sellingPriceRmb ? (seaProfit / sellingPriceRmb) * 100 : 0;

  setVal("expressProfitRate", expressProfitRate);
  setVal("airProfitRate", airProfitRate);
  setVal("seaProfitRate", seaProfitRate);
}

function fetchRate(){
  fetch("https://open.er-api.com/v6/latest/USD")
    .then(res => res.json())
    .then(data => {
      const rate = Number((data && data.rates && data.rates.CNY) || 0);
      if (!rate) return alert("汇率获取失败");
      $("exchangeRate").value = (rate * 0.9).toFixed(4);
      calcAll();
    })
    .catch(err => {
      console.error(err);
      alert("汇率获取失败");
    });
}

window.addEventListener("DOMContentLoaded", () => {
  const photoInput = $("photoInput");
  const photoBox = $("photoPreviewBox");
  if (photoInput && photoBox) {
    photoInput.addEventListener("change", function () {
      const file = this.files && this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (e) {
        photoBox.innerHTML = '<img src="' + e.target.result + '" style="max-width:100%;max-height:100%;object-fit:contain;">';
      };
      reader.readAsDataURL(file);
    });
  }

  const deleteBtn = $("deletePhotoBtn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", function () {
      const m = window.location.pathname.match(/^\\/edit\\/(\\d+)$/);
      if (m) {
        if (confirm("确定删除这张照片吗？")) {
          window.location.href = "/delete-photo/" + m[1];
        }
      } else {
        if ($("photoInput")) $("photoInput").value = "";
        if ($("photoPreviewBox")) {
          $("photoPreviewBox").innerHTML = '<div class="photo-inner">ⓘ<span>暂无照片</span></div>';
        }
      }
    });
  }

  const codeInput = $("productCode");
  if (codeInput && (!codeInput.value || codeInput.value === "自动生成")) {
    fetch("/api/generate-product-code")
      .then(res => res.json())
      .then(data => { if (data && data.code) codeInput.value = data.code; })
      .catch(() => {});
  }

  ["expressUnitPrice","airUnitPrice","seaUnitPrice"].forEach(id => {
    const el = $(id);
    if (!el) return;
    if (!el.value) el.value = localStorage.getItem(id) || "";
    el.addEventListener("change", function () {
      localStorage.setItem(id, this.value || "");
      calcAll();
    });
    el.addEventListener("input", calcAll);
  });

  document.querySelectorAll(".calc").forEach(el => {
    el.addEventListener("input", calcAll);
    el.addEventListener("change", calcAll);
  });

  calcAll();
  if ($("exchangeRate") && !$("exchangeRate").value) fetchRate();
});
</script>
</body>
</html>`;
}

function renderListPage(rows, user) {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <title>产品列表</title>
    <style>
      body{font-family:Arial,"Microsoft YaHei",sans-serif;background:#fff;margin:20px;}
      table{width:100%;border-collapse:collapse;}
      th,td{border:1px solid #ccc;padding:10px;text-align:center;}
      th{background:#f3f3f3;}
      a{color:#2f6fed;text-decoration:none;}
      .status-pending{color:#d97706;font-weight:bold;}
      .status-approved{color:#16a34a;font-weight:bold;}
      .status-rejected{color:#dc2626;font-weight:bold;}
    </style>
  </head>
  <body>
    <h2>产品列表</h2>
    ${renderTopButtons(user)}
    <table>
      <tr>
        <th>ID</th>
        <th>图片</th>
        <th>产品名称</th>
        <th>产品编号</th>
        <th>创建人</th>
        <th>状态</th>
        <th>更新时间</th>
        <th>操作</th>
      </tr>
      ${rows.map(r => `
        <tr>
          <td>${r.id}</td>
          <td>${r.photoPath ? `<img src="/uploads/${esc(r.photoPath)}" style="width:60px;height:60px;object-fit:cover;">` : ""}</td>
          <td>${esc(r.productName || "")}</td>
          <td>${esc(r.productCode || "")}</td>
          <td>${esc(r.ownerUsername || "")}</td>
          <td class="status-${esc(r.approveStatus || "pending")}">${esc(r.approveStatus || "pending")}</td>
          <td>${esc(formatTime(r.updatedAt || r.createdAt || ""))}</td>
          <td>
            <a href="/detail/${r.id}">查看</a> |
            <a href="/edit/${r.id}">编辑</a>
            ${user && user.is_admin ? ` | <a href="/approve-product/${r.id}">通过</a> | <a href="/reject-product/${r.id}">拒绝</a>` : ""}
            | <a href="/delete/${r.id}" onclick="return confirm('确定删除吗？')">删除</a>
          </td>
        </tr>
      `).join("")}
    </table>
  </body>
  </html>`;
}

function renderUsersPage(rows, user) {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <title>用户列表</title>
    <style>
      body{font-family:Arial,"Microsoft YaHei",sans-serif;background:#fff;margin:20px;}
      table{width:100%;border-collapse:collapse;}
      th,td{border:1px solid #ccc;padding:10px;text-align:center;}
      th{background:#f3f3f3;}
      a{color:#2f6fed;text-decoration:none;}
    </style>
  </head>
  <body>
    <h2>用户列表</h2>
    ${renderTopButtons(user)}
    <table>
      <tr>
        <th>ID</th>
        <th>用户名</th>
        <th>身份</th>
        <th>审批状态</th>
        <th>操作</th>
      </tr>
      ${rows.map(r => `
        <tr>
          <td>${r.id}</td>
          <td>${esc(r.username)}</td>
          <td>${r.is_admin ? "管理员" : "普通用户"}</td>
          <td>${esc(r.approval_status || "pending")}</td>
          <td>
            <a href="/user-products/${r.id}">产品</a>
            ${!r.is_admin ? ` | <a href="/approve-user/${r.id}">通过</a> | <a href="/reject-user/${r.id}">拒绝</a> | <a href="/delete-user/${r.id}" onclick="return confirm('确定删除用户及其产品吗？')">删除</a>` : ""}
          </td>
        </tr>
      `).join("")}
    </table>
  </body>
  </html>`;
}

function renderDetailPage(row, user) {
  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <title>详情</title>
    <style>
      body{font-family:Arial,"Microsoft YaHei",sans-serif;background:#fff;margin:20px;}
      table{width:100%;border-collapse:collapse;}
      th,td{border:1px solid #ccc;padding:10px;vertical-align:top;}
      th{width:220px;background:#f3f3f3;text-align:right;}
      img{max-width:320px;max-height:320px;object-fit:contain;}
    </style>
  </head>
  <body>
    <h2>产品详情</h2>
    ${renderTopButtons(user)}
    <table>
      <tr><th>图片</th><td>${row.photoPath ? `<img src="/uploads/${esc(row.photoPath)}">` : "无"}</td></tr>
      ${Object.keys(row).filter(k => k !== "photoPath").map(k => `<tr><th>${esc(k)}</th><td>${esc(row[k] || "")}</td></tr>`).join("")}
    </table>
  </body>
  </html>`;
}

app.get("/", (req, res) => res.redirect("/login"));
app.get("/login", (req, res) => res.send(renderLoginPage()));
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const row = await getAsync("SELECT * FROM users WHERE username = ?", [username]);
  if (!row || row.password_hash !== hashPassword(password)) {
    return res.send(renderLoginPage("用户名或密码错误"));
  }
  if (!row.is_admin && row.approval_status !== "approved") {
    return res.send(renderLoginPage("账户还未通过管理员审核"));
  }
  await runAsync("UPDATE users SET last_login_at=datetime('now','localtime') WHERE id=?", [row.id]);
  req.session.user = { id: row.id, username: row.username, is_admin: !!row.is_admin };
  res.redirect("/form");
});

app.get("/register", (req, res) => res.send(renderRegisterPage()));
app.post("/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "").trim();
  if (!username || !password) return res.send(renderRegisterPage("请填写完整"));
  try {
    await runAsync(
      `INSERT INTO users (username, password_hash, password_plain, approval_status)
       VALUES (?, ?, ?, 'pending')`,
      [username, hashPassword(password), password]
    );
    res.send(renderLoginPage("注册成功，等待管理员审核"));
  } catch (err) {
    res.send(renderRegisterPage("用户名已存在或保存失败"));
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/api/generate-product-code", checkLogin, (req, res) => {
  generateProductCode((err, code) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ code });
  });
});

app.get("/form", checkLogin, (req, res) => {
  res.send(renderFormPage({ mode: "create", user: req.session.user, row: {} }));
});

app.get("/edit/:id", checkLogin, async (req, res) => {
  const row = await getAsync("SELECT * FROM products WHERE id = ?", [req.params.id]);
  if (!row) return res.send("记录不存在");
  if (!req.session.user.is_admin && row.ownerUserId !== req.session.user.id) {
    return res.status(403).send("无权限");
  }
  res.send(renderFormPage({ mode: "edit", user: req.session.user, row }));
});

app.get("/detail/:id", checkLogin, async (req, res) => {
  const row = await getAsync("SELECT * FROM products WHERE id = ?", [req.params.id]);
  if (!row) return res.send("记录不存在");
  if (!req.session.user.is_admin && row.ownerUserId !== req.session.user.id) {
    return res.status(403).send("无权限");
  }
  res.send(renderDetailPage(row, req.session.user));
});

app.get("/delete/:id", checkLogin, async (req, res) => {
  const row = await getAsync("SELECT * FROM products WHERE id = ?", [req.params.id]);
  if (!row) return res.send("记录不存在");
  if (!req.session.user.is_admin && row.ownerUserId !== req.session.user.id) {
    return res.status(403).send("无权限");
  }
  deletePhotoFile(row.photoPath);
  await runAsync("DELETE FROM products WHERE id = ?", [req.params.id]);
  res.redirect("/list");
});

app.get("/delete-photo/:id", checkLogin, async (req, res) => {
  const row = await getAsync("SELECT * FROM products WHERE id = ?", [req.params.id]);
  if (!row) return res.send("记录不存在");
  if (!req.session.user.is_admin && row.ownerUserId !== req.session.user.id) {
    return res.status(403).send("无权限");
  }
  deletePhotoFile(row.photoPath);
  await runAsync(
    `UPDATE products SET photoPath='', updatedAt=datetime('now','localtime'),
     lastEditedByUserId=?, lastEditedByUsername=? WHERE id=?`,
    [req.session.user.id, req.session.user.username, req.params.id]
  );
  res.redirect(`/edit/${req.params.id}`);
});

function getProductFields(d, photoPath, user, existingApproveStatus) {
  return [
    d.formName || "",
    d.productName || "",
    d.productCode || "",
    d.exchangeRate || "",
    d.purchaseCost || "",
    d.commissionRate || "",
    d.fenxiaoPrice || "",
    d.adRate || "",
    d.profitCostDiff || "",
    d.profitRate1 || "",
    d.sellingPriceUsd || "",
    d.sellingPriceRmb || "",
    d.profitSellDiff || "",
    d.profitRate2 || "",
    d.remark || "",
    d.packageType || "",
    d.volumeWeight6000 || "",
    d.volumeWeight5000 || "",
    d.actualWeight || "",
    d.lengthCm || "",
    d.widthCm || "",
    d.heightCm || "",
    d.expressFee || "",
    d.expressProfit || "",
    d.expressProfitRate || "",
    d.airFee || "",
    d.airProfit || "",
    d.airProfitRate || "",
    d.seaFee || "",
    d.seaProfit || "",
    d.seaProfitRate || "",
    d.expressWeightQty || "",
    d.expressUnitPrice || "",
    d.expressTax || "",
    d.expressTotalPrice || "",
    d.airWeightQty || "",
    d.airUnitPrice || "",
    d.airTax || "",
    d.airTotalPrice || "",
    d.seaWeightQty || "",
    d.seaUnitPrice || "",
    d.seaTax || "",
    d.seaTotalPrice || "",
    d.fbaFeeRmb || "",
    d.commissionRmb || "",
    d.returnCostRmb || "",
    d.warehouseUsd || "",
    d.deliveryUsd || "",
    d.adCostRmb || "",
    existingApproveStatus || "pending",
    d.competitor1Name || "",
    d.competitor1Link || "",
    d.competitor1Image || "",
    d.competitor1Price || "",
    d.competitor2Name || "",
    d.competitor2Link || "",
    d.competitor2Image || "",
    d.competitor2Price || "",
    d.competitor3Name || "",
    d.competitor3Link || "",
    d.competitor3Image || "",
    d.competitor3Price || "",
    "[]",
    photoPath,
    user.id,
    user.username
  ];
}

app.post("/save", checkLogin, upload.single("photo"), async (req, res) => {
  const d = req.body;
  const user = req.session.user;
  let productCode = d.productCode || "";
  if (!productCode || productCode === "自动生成") {
    productCode = await new Promise((resolve, reject) => {
      generateProductCode((err, code) => (err ? reject(err) : resolve(code)));
    });
  }
  d.productCode = productCode;
  const photoPath = req.file ? req.file.filename : "";

  await runAsync(
    `INSERT INTO products (
      formName, productName, productCode, exchangeRate, purchaseCost, commissionRate,
      fenxiaoPrice, adRate, profitCostDiff, profitRate1,
      sellingPriceUsd, sellingPriceRmb, profitSellDiff, profitRate2,
      remark, packageType,
      volumeWeight6000, volumeWeight5000, actualWeight, lengthCm, widthCm, heightCm,
      expressFee, expressProfit, expressProfitRate,
      airFee, airProfit, airProfitRate,
      seaFee, seaProfit, seaProfitRate,
      expressWeightQty, expressUnitPrice, expressTax, expressTotalPrice,
      airWeightQty, airUnitPrice, airTax, airTotalPrice,
      seaWeightQty, seaUnitPrice, seaTax, seaTotalPrice,
      fbaFeeRmb, commissionRmb, returnCostRmb, warehouseUsd, deliveryUsd, adCostRmb,
      approveStatus,
      competitor1Name, competitor1Link, competitor1Image, competitor1Price,
      competitor2Name, competitor2Link, competitor2Image, competitor2Price,
      competitor3Name, competitor3Link, competitor3Image, competitor3Price,
      changedFields,
      photoPath, ownerUserId, ownerUsername, lastEditedByUserId, lastEditedByUsername,
      createdAt, updatedAt
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?, ?,
      datetime('now','localtime'), datetime('now','localtime')
    )`,
    getProductFields(d, photoPath, user, "pending")
  );

  res.redirect("/list");
});

app.post("/update/:id", checkLogin, upload.single("photo"), async (req, res) => {
  const id = req.params.id;
  const old = await getAsync("SELECT * FROM products WHERE id = ?", [id]);
  if (!old) return res.send("记录不存在");
  if (!req.session.user.is_admin && old.ownerUserId !== req.session.user.id) {
    return res.status(403).send("无权限");
  }

  const d = req.body;
  const user = req.session.user;
  const newPhotoPath = req.file ? req.file.filename : old.photoPath;

  if (req.file && old.photoPath) {
    deletePhotoFile(old.photoPath);
  }

  await runAsync(
    `UPDATE products SET
      formName=?, productName=?, productCode=?, exchangeRate=?, purchaseCost=?, commissionRate=?,
      fenxiaoPrice=?, adRate=?, profitCostDiff=?, profitRate1=?,
      sellingPriceUsd=?, sellingPriceRmb=?, profitSellDiff=?, profitRate2=?,
      remark=?, packageType=?,
      volumeWeight6000=?, volumeWeight5000=?, actualWeight=?, lengthCm=?, widthCm=?, heightCm=?,
      expressFee=?, expressProfit=?, expressProfitRate=?,
      airFee=?, airProfit=?, airProfitRate=?,
      seaFee=?, seaProfit=?, seaProfitRate=?,
      expressWeightQty=?, expressUnitPrice=?, expressTax=?, expressTotalPrice=?,
      airWeightQty=?, airUnitPrice=?, airTax=?, airTotalPrice=?,
      seaWeightQty=?, seaUnitPrice=?, seaTax=?, seaTotalPrice=?,
      fbaFeeRmb=?, commissionRmb=?, returnCostRmb=?, warehouseUsd=?, deliveryUsd=?, adCostRmb=?,
      approveStatus=?,
      competitor1Name=?, competitor1Link=?, competitor1Image=?, competitor1Price=?,
      competitor2Name=?, competitor2Link=?, competitor2Image=?, competitor2Price=?,
      competitor3Name=?, competitor3Link=?, competitor3Image=?, competitor3Price=?,
      changedFields=?,
      photoPath=?, lastEditedByUserId=?, lastEditedByUsername=?, updatedAt=datetime('now','localtime')
    WHERE id=?`,
    [...getProductFields(d, newPhotoPath, user, old.approveStatus), id]
  );

  res.redirect("/list");
});

app.get("/list", checkLogin, async (req, res) => {
  const user = req.session.user;
  const rows = user.is_admin
    ? await allAsync("SELECT * FROM products ORDER BY id DESC")
    : await allAsync("SELECT * FROM products WHERE ownerUserId=? ORDER BY id DESC", [user.id]);
  res.send(renderListPage(rows, user));
});

app.get("/users", checkLogin, checkAdmin, async (req, res) => {
  const rows = await allAsync("SELECT * FROM users ORDER BY id DESC");
  res.send(renderUsersPage(rows, req.session.user));
});

app.get("/delete-user/:id", checkLogin, checkAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) return res.send("用户ID无效");
  if (userId === req.session.user.id) return res.send("不能删除当前登录的管理员自己");

  const userRow = await getAsync("SELECT * FROM users WHERE id=?", [userId]);
  if (!userRow) return res.send("用户不存在");

  const rows = await allAsync("SELECT photoPath FROM products WHERE ownerUserId=?", [userId]);
  rows.forEach(r => deletePhotoFile(r.photoPath));

  await runAsync("DELETE FROM products WHERE ownerUserId=?", [userId]);
  await runAsync("DELETE FROM users WHERE id=?", [userId]);
  res.redirect("/users");
});

app.get("/approve-user/:id", checkLogin, checkAdmin, async (req, res) => {
  await runAsync(
    `UPDATE users SET approval_status='approved', approved_by=?, approved_at=datetime('now','localtime') WHERE id=?`,
    [req.session.user.username, req.params.id]
  );
  res.redirect("/users");
});

app.get("/reject-user/:id", checkLogin, checkAdmin, async (req, res) => {
  await runAsync(`UPDATE users SET approval_status='rejected' WHERE id=?`, [req.params.id]);
  res.redirect("/users");
});

app.get("/user-products/:userId", checkLogin, checkAdmin, async (req, res) => {
  const rows = await allAsync("SELECT * FROM products WHERE ownerUserId = ? ORDER BY id DESC", [req.params.userId]);
  res.send(renderListPage(rows, req.session.user));
});

app.get("/approve-product/:id", checkLogin, checkAdmin, async (req, res) => {
  await runAsync(
    `UPDATE products SET approveStatus='approved', approvedBy=?, approvedAt=datetime('now','localtime') WHERE id=?`,
    [req.session.user.username, req.params.id]
  );
  res.redirect("/list");
});

app.get("/reject-product/:id", checkLogin, checkAdmin, async (req, res) => {
  await runAsync(`UPDATE products SET approveStatus='rejected' WHERE id=?`, [req.params.id]);
  res.redirect("/list");
});

app.get("/inbox", checkLogin, checkAdmin, async (req, res) => {
  const rows = await allAsync(`SELECT * FROM weekly_reports ORDER BY createdAt DESC`);
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>管理员收件箱</title>
      <style>
        body{font-family:Arial,"Microsoft YaHei",sans-serif;margin:20px;background:#fff;}
        table{width:100%;border-collapse:collapse;margin-top:20px;}
        th,td{border:1px solid #ccc;padding:10px;text-align:center;}
        th{background:#f3f3f3;}
        a{color:#2f6fed;text-decoration:none;}
        .btn{display:inline-block;background:#2f6fed;color:#fff !important;text-decoration:none;padding:10px 16px;border-radius:4px;font-size:14px;}
      </style>
    </head>
    <body>
      <h2>管理员收件箱</h2>
      ${renderTopButtons(req.session.user)}
      <div style="margin:12px 0;">
        <a href="/generate-weekly-pdf" class="btn" onclick="return confirm('确定立即生成一份新的汇总PDF吗？')">立即生成汇总PDF</a>
      </div>
      <table>
        <tr><th>周开始</th><th>周结束</th><th>时间</th><th>PDF</th></tr>
        ${rows.map(r => `
          <tr>
            <td>${esc(r.weekStart || "")}</td>
            <td>${esc(r.weekEnd || "")}</td>
            <td>${esc(r.createdAt || "")}</td>
            <td><a href="/${esc(r.pdfPath || "")}" target="_blank">查看</a></td>
          </tr>`).join("")}
      </table>
    </body>
    </html>
  `);
});

app.get("/generate-weekly-pdf", checkLogin, checkAdmin, (req, res) => {
  generateWeeklySummaryPdf((err) => {
    if (err) return res.send("生成PDF失败：" + err.message);
    res.redirect("/inbox");
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
