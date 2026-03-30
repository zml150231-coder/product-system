const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();
const session = require("express-session");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const XLSX = require("xlsx");
const app = express();
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const db = new sqlite3.Database(path.join(ROOT, "data.db"));

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateProductCode(callback) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `${year}${month}`;

  db.get(
    "SELECT productCode FROM products WHERE productCode LIKE ? ORDER BY productCode DESC LIMIT 1",
    [`${prefix}%`],
    (err, row) => {
      if (err) return callback(err);

      let seq = 1;
      if (row && row.productCode) {
        const last = parseInt(row.productCode.slice(-3), 10);
        if (!isNaN(last)) {
          seq = last + 1;
        }
      }

      const newCode = `${prefix}${String(seq).padStart(3, "0")}`;
      callback(null, newCode);
    }
  );
}

function formatTimeCN(value) {
  if (!value) return "";
  const d = new Date(value.replace(" ", "T") + "Z");
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

function formatTime(value) {
  if (!value) return "";
  const d = new Date(value.replace(" ", "T") + "Z");
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
      console.error("删除照片失败:", err);
    }
  }
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_plain TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
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

      photoPath TEXT,

      ownerUserId INTEGER,
      ownerUsername TEXT,
      lastEditedByUserId INTEGER,
      lastEditedByUsername TEXT,

      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.get("SELECT * FROM users WHERE username = ?", ["gly123"], (err, row) => {
    if (err) {
      console.error(err);
      return;
    }
    if (!row) {
      db.run(
        `INSERT INTO users
         (username, password_hash, password_plain, is_admin)
         VALUES (?, ?, ?, 1)`,
        ["gly123", hashPassword("6604"), "6604"],
        (e) => {
          if (e) console.error(e);
        }
      );
    }
  });
});

app.use(express.urlencoded({ extended: true }));
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
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
}

function checkAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.status(403).send("只有管理员可以访问");
  }
  next();
}

app.get("/delete-user/:id", checkLogin, checkAdmin, (req, res) => {
  const userId = Number(req.params.id);

  if (!userId) {
    return res.send("用户ID无效");
  }

  if (userId === req.session.user.id) {
    return res.send("不能删除当前登录的管理员自己");
  }

  db.get("SELECT * FROM users WHERE id = ?", [userId], (err, userRow) => {
    if (err) {
      return res.send("查询用户失败：" + err.message);
    }

    if (!userRow) {
      return res.send("用户不存在");
    }

    db.all("SELECT photoPath FROM products WHERE ownerUserId = ?", [userId], (err2, rows) => {
      if (err2) {
        return res.send("查询该用户产品失败：" + err2.message);
      }

      (rows || []).forEach(row => {
        if (row.photoPath) {
          deletePhotoFile(row.photoPath);
        }
      });

      db.run("DELETE FROM products WHERE ownerUserId = ?", [userId], function (err3) {
        if (err3) {
          return res.send("删除该用户产品失败：" + err3.message);
        }

        db.run("DELETE FROM users WHERE id = ?", [userId], function (err4) {
          if (err4) {
            return res.send("删除用户失败：" + err4.message);
          }

          res.redirect("/users");
        });
      });
    });
  });
});

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
      ${blueBtn("/list", "产品列表")}
      ${blueBtn("/form", "新增表单")}
      ${user && user.is_admin ? blueBtn("/users", "查看用户") : ""}
      ${blueBtn("/logout", "退出登录")}
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
        body{
          margin:0;
          background:#ffffff;
          font-family:Arial,"Microsoft YaHei",sans-serif;
        }
        .wrap{
          width:420px;
          margin:90px auto;
          border:1px solid #d9d9d9;
          border-radius:10px;
          padding:30px;
          box-sizing:border-box;
          background:#fff;
        }
        h1{
          margin:0 0 20px 0;
          text-align:center;
          font-size:24px;
        }
        input{
          width:100%;
          box-sizing:border-box;
          padding:12px;
          margin-top:12px;
          border:1px solid #cfcfcf;
        }
        button{
          width:100%;
          margin-top:18px;
          height:44px;
          border:none;
          background:#2f6fed;
          color:#fff;
          cursor:pointer;
          font-size:16px;
        }
        .msg{
          color:#c62828;
          margin-top:10px;
        }
        .line{
          margin-top:18px;
          text-align:center;
        }
        a{
          text-decoration:none;
          color:#2f6fed;
        }
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
    </html>
  `;
}

function renderRegisterPage(message = "") {
  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>Product Development Record Sheet - Register</title>
      <style>
        body{
          margin:0;
          background:#ffffff;
          font-family:Arial,"Microsoft YaHei",sans-serif;
        }
        .wrap{
          width:420px;
          margin:90px auto;
          border:1px solid #d9d9d9;
          border-radius:10px;
          padding:30px;
          box-sizing:border-box;
          background:#fff;
        }
        h1{
          margin:0 0 20px 0;
          text-align:center;
          font-size:24px;
        }
        input{
          width:100%;
          box-sizing:border-box;
          padding:12px;
          margin-top:12px;
          border:1px solid #cfcfcf;
        }
        button{
          width:100%;
          margin-top:18px;
          height:44px;
          border:none;
          background:#2f6fed;
          color:#fff;
          cursor:pointer;
          font-size:16px;
        }
        .msg{
          color:#c62828;
          margin-top:10px;
        }
        .line{
          margin-top:18px;
          text-align:center;
        }
        a{
          text-decoration:none;
          color:#2f6fed;
        }
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
    </html>
  `;
}

function renderFormPage({ mode, user, row = {} }) {
  const isEdit = mode === "edit";
  const action = isEdit ? `/update/${row.id}` : "/save";
  const title = isEdit ? "Product Development Record Sheet - 编辑表单" : "Product Development Record Sheet - 新增表单";
  const buttonText = isEdit ? "保存修改" : "提交";

  const photoHtml = row.photoPath
    ? `<img src="/uploads/${esc(row.photoPath)}" style="max-width:100%;max-height:100%;object-fit:contain;">`
    : `<div class="photo-inner">ⓘ<span>暂无照片</span></div>`;

 const deletePhotoLink = isEdit && row.photoPath
  ? `<a href="/delete-photo/${row.id}" onclick="return confirm('确定删除这张照片吗？')">删除照片</a>`
  : `<span style="color:#999;">删除照片</span>`;

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, "Microsoft YaHei", sans-serif;
      background: #ffffff;
      color: #222;
    }
    .topbar {
      background: #ffffff;
      border-bottom: 1px solid #d0d0d0;
      padding: 10px 16px;
      font-size: 22px;
      font-weight: bold;
    }
    .page {
      width: 1360px;
      margin: 8px auto 30px auto;
      background: #ffffff;
      border: 1px solid #bdbdbd;
    }
    .button-area{
      padding:16px;
      border-bottom:1px solid #d0d0d0;
      background:#fff;
    }
    .section {
      background: #d8d8d8;
      border-bottom: 1px solid #8f8f8f;
    }
    table.layout {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 14px;
    }
    table.layout td,
    table.layout th {
      border: 1px solid #8f8f8f;
      padding: 6px 8px;
      vertical-align: middle;
      background: #efefef;
    }
    table.layout th {
      background: #d1d1d1;
      font-weight: normal;
      text-align: center;
    }
    .label {
      width: 120px;
      text-align: right;
      background: #e3e3e3 !important;
      white-space: nowrap;
    }
    .input,
    .textarea {
      width: 100%;
      box-sizing: border-box;
      height: 30px;
      border: 1px solid #9a9a9a;
      background: #f8f8f8;
      padding: 4px 8px;
      font-size: 14px;
    }
    .textarea {
      height: 90px;
      resize: vertical;
      padding-top: 6px;
    }
    .readonly-red {
      border: 1px solid #c95d5d;
      background: #f3f3f3;
    }
    .readonly-gray {
      background: #b9b9b9;
      color: #111;
    }
    .photo-box {
      height: 290px;
      background: #f5f5f5;
      border: 1px solid #b3b3b3;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #aaa;
      font-size: 44px;
      position: relative;
      overflow: hidden;
    }
    .photo-inner {
      text-align: center;
    }
    .photo-inner span {
      display: block;
      font-size: 18px;
      margin-top: 8px;
      color: #bbb;
    }
    .upload-row {
      margin-top: 10px;
      font-size: 13px;
      color: #444;
      display:flex;
      gap:16px;
      align-items:center;
      flex-wrap:wrap;
    }
    .white-gap {
      height: 70px;
      background: #ffffff;
      border-top: 1px solid #8f8f8f;
      border-bottom: 1px solid #8f8f8f;
    }
    .submit-wrap {
      padding: 14px;
      background: #d8d8d8;
      border-top: 1px solid #8f8f8f;
    }
    .submit-btn {
      width: 100%;
      height: 42px;
      background: #2f6fed;
      border: none;
      color: #fff;
      font-size: 16px;
      cursor: pointer;
    }
    .title-bar {
      background: #a8a8a8 !important;
      color: #fff;
      text-align: center;
      font-size: 22px;
      padding: 10px 0 !important;
      font-weight: bold;
    }
    .left-title {
      background: #8c8c8c !important;
      color: white;
      text-align: center;
      font-size: 28px;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      letter-spacing: 2px;
      width: 70px;
    }
    .money-tag {
      white-space: nowrap;
      font-size: 13px;
    }
    .small-btn{
      display:inline-block;
      padding:6px 10px;
      background:#2f6fed;
      color:#fff !important;
      text-decoration:none;
      border-radius:3px;
      font-size:13px;
      border:none;
      cursor:pointer;
    }
    .meta-box{
      font-size:13px;
      color:#444;
      padding:10px 16px;
      border-bottom:1px solid #d0d0d0;
      background:#fff;
    }
  </style>
</head>
<body>
  <div class="topbar">Product Development Record Sheet</div>

  <div class="page">
    <div class="button-area">
      ${renderTopButtons(user)}
      ${isEdit ? `<span style="font-size:13px;color:#444;">创建人：${esc(row.ownerUsername || "")} ｜ 最后编辑人：${esc(row.lastEditedByUsername || "")} ｜ 创建时间：${esc(formatTime(row.createdAt))}
最后更新时间：${esc(formatTime(row.updatedAt))}</span>` : ""}
    </div>

    <form method="POST" action="${action}" enctype="multipart/form-data">
      <div class="section">
        <table class="layout">
          <colgroup>
            <col style="width: 390px;">
            <col style="width: 260px;">
            <col style="width: 250px;">
            <col style="width: 230px;">
            <col style="width: 230px;">
          </colgroup>
          <tr>
            <td rowspan="8" style="vertical-align: top; background:#efefef;">
              <div class="photo-box" id="photoPreviewBox">
                ${photoHtml}
              </div>
              <div class="upload-row">
                <label class="small-btn" for="photoInput">上传照片</label>
                <input id="photoInput" type="file" name="photo" accept="image/*" style="display:none;">
                ${deletePhotoLink}
              </div>
            </td>

            <td class="label">表单名称*</td>
            <td><input class="input" type="text" name="formName" id="formName" value="${esc(row.formName || "")}" /></td>
            <td class="label">产品名称*</td>
            <td><input class="input" type="text" name="productName" id="productName" value="${esc(row.productName || "")}" /></td>
          </tr>
          <tr>
            <td class="label">产品编号</td>
            <td><input class="input readonly-gray" type="text" name="productCode" id="productCode" value="${esc(row.productCode || "自动生成")}" readonly /></td>
            <td class="label">汇率</td>
            <td>
              <div style="display:flex;gap:8px;">
                <input class="input calc" type="number" step="0.0001" name="exchangeRate" id="exchangeRate" value="${esc(row.exchangeRate || "")}" />
                <button type="button" class="small-btn" style="width:110px;" onclick="fetchRate()">刷新汇率</button>
              </div>
            </td>
          </tr>
          <tr>
            <td class="label">采购成本(RMB)*</td>
            <td><input class="input calc" type="number" step="0.001" name="purchaseCost" id="purchaseCost" value="${esc(row.purchaseCost || "")}" /></td>
            <td class="label">佣金(%)</td>
            <td><input class="input calc" type="number" step="0.001" name="commissionRate" id="commissionRate" value="${esc(row.commissionRate || "15")}" /></td>
          </tr>
          <tr>
            <td class="label">分销价*</td>
            <td><input class="input calc" type="number" step="0.001" name="fenxiaoPrice" id="fenxiaoPrice" value="${esc(row.fenxiaoPrice || "")}" /></td>
            <td class="label">广告费(%)</td>
            <td><input class="input calc" type="number" step="0.001" name="adRate" id="adRate" value="${esc(row.adRate || "15")}" /></td>
          </tr>
          <tr>
            <td class="label">分销减采购成本利润*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="profitCostDiff" id="profitCostDiff" value="${esc(row.profitCostDiff || "")}" /></td>
            <td class="label">利润率1(%)*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="profitRate1" id="profitRate1" value="${esc(row.profitRate1 || "")}" /></td>
          </tr>
          <tr>
            <td class="label">销售价(USD)*</td>
            <td><input class="input calc" type="number" step="0.001" name="sellingPriceUsd" id="sellingPriceUsd" value="${esc(row.sellingPriceUsd || "")}" /></td>
            <td class="label">销售价(RMB)*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="sellingPriceRmb" id="sellingPriceRmb" value="${esc(row.sellingPriceRmb || "")}" /></td>
          </tr>
          <tr>
            <td class="label">销售价-分销价利润*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="profitSellDiff" id="profitSellDiff" value="${esc(row.profitSellDiff || "")}" /></td>
            <td class="label">利润率2(%)*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="profitRate2" id="profitRate2" value="${esc(row.profitRate2 || "")}" /></td>
          </tr>
          <tr>
            <td class="label">备注</td>
            <td colspan="3"><textarea class="textarea" name="remark" id="remark">${esc(row.remark || "")}</textarea></td>
          </tr>
        </table>
      </div>

      <div class="white-gap"></div>

      <div class="section">
        <table class="layout">
          <colgroup>
            <col style="width: 90px;">
            <col style="width: 240px;">
            <col style="width: 60px;">
            <col style="width: 240px;">
            <col style="width: 240px;">
            <col style="width: 240px;">
            <col style="width: 240px;">
          </colgroup>
          <tr>
            <td class="label">包装方式*</td>
            <td><input class="input" type="text" name="packageType" id="packageType" value="${esc(row.packageType || "")}" /></td>
            <td colspan="2" class="title-bar">包装尺寸</td>
            <th>长/CM</th>
            <th>宽/CM</th>
            <th>高/CM</th>
          </tr>
          <tr>
            <td class="label">体积重1(/6000)*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="volumeWeight6000" id="volumeWeight6000" value="${esc(row.volumeWeight6000 || "")}" /></td>
            <td class="money-tag">KG</td>
            <td></td>
            <td><input class="input calc" type="number" step="0.001" name="lengthCm" id="lengthCm" value="${esc(row.lengthCm || "")}" /></td>
            <td><input class="input calc" type="number" step="0.001" name="widthCm" id="widthCm" value="${esc(row.widthCm || "")}" /></td>
            <td><input class="input calc" type="number" step="0.001" name="heightCm" id="heightCm" value="${esc(row.heightCm || "")}" /></td>
          </tr>
          <tr>
            <td class="label">体积重2(/5000)*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="volumeWeight5000" id="volumeWeight5000" value="${esc(row.volumeWeight5000 || "")}" /></td>
            <td class="money-tag">KG</td>
            <td colspan="4"></td>
          </tr>
          <tr>
            <td class="label">实重*</td>
            <td><input class="input" type="number" step="0.001" name="actualWeight" id="actualWeight" value="${esc(row.actualWeight || "")}" /></td>
            <td class="money-tag">KG</td>
            <td colspan="4"></td>
          </tr>
        </table>
      </div>

      <div class="white-gap"></div>

      <div class="section">
        <table class="layout">
          <colgroup>
            <col style="width: 90px;">
            <col style="width: 240px;">
            <col style="width: 100px;">
            <col style="width: 240px;">
            <col style="width: 170px;">
            <col style="width: 240px;">
            <col style="width: 170px;">
            <col style="width: 170px;">
          </colgroup>

          <tr>
            <td rowspan="4" class="left-title">运输方式</td>
            <th></th><th></th><th></th><th></th><th></th><th></th><th></th>
          </tr>
          <tr>
            <td class="label">快递:</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="expressFee" id="expressFee" value="${esc(row.expressFee || "")}" /></td>
            <td class="money-tag">(RMB) 利润</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="expressProfit" id="expressProfit" value="${esc(row.expressProfit || "")}" /></td>
            <td class="money-tag">(RMB)</td>
            <td class="label">利润率(%)*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="expressProfitRate" id="expressProfitRate" value="${esc(row.expressProfitRate || "")}" /></td>
          </tr>
          <tr>
            <td class="label">空运:</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="airFee" id="airFee" value="${esc(row.airFee || "")}" /></td>
            <td class="money-tag">(RMB) 利润</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="airProfit" id="airProfit" value="${esc(row.airProfit || "")}" /></td>
            <td class="money-tag">(RMB)</td>
            <td class="label">利润率(%)*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="airProfitRate" id="airProfitRate" value="${esc(row.airProfitRate || "")}" /></td>
          </tr>
          <tr>
            <td class="label">海运:</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="seaFee" id="seaFee" value="${esc(row.seaFee || "")}" /></td>
            <td class="money-tag">(RMB) 利润</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="seaProfit" id="seaProfit" value="${esc(row.seaProfit || "")}" /></td>
            <td class="money-tag">(RMB)</td>
            <td class="label">利润率(%)*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="seaProfitRate" id="seaProfitRate" value="${esc(row.seaProfitRate || "")}" /></td>
          </tr>
        </table>

        <table class="layout">
          <colgroup>
            <col style="width: 90px;">
            <col style="width: 240px;">
            <col style="width: 240px;">
            <col style="width: 240px;">
            <col style="width: 240px;">
            <col style="width: 240px;">
          </colgroup>
          <tr>
            <th></th>
            <th>计重数量</th>
            <th>单价(RMB)</th>
            <th>税费(RMB)</th>
            <th>价格(RMB)</th>
            <th></th>
          </tr>
          <tr>
            <td class="label">快递</td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="expressWeightQty" id="expressWeightQty" value="${esc(row.expressWeightQty || "")}" readonly /></td>
            <td><input class="input calc" type="number" step="0.001" name="expressUnitPrice" id="expressUnitPrice" value="${esc(row.expressUnitPrice || "")}" /></td>
            <td><input class="input calc" type="number" step="0.001" name="expressTax" id="expressTax" value="${esc(row.expressTax || "")}" /></td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="expressTotalPrice" id="expressTotalPrice" value="${esc(row.expressTotalPrice || "")}" /></td>
            <td></td>
          </tr>
          <tr>
            <td class="label">空运</td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="airWeightQty" id="airWeightQty" value="${esc(row.airWeightQty || "")}" readonly /></td>
            <td><input class="input calc" type="number" step="0.001" name="airUnitPrice" id="airUnitPrice" value="${esc(row.airUnitPrice || "")}" /></td>
            <td><input class="input calc" type="number" step="0.001" name="airTax" id="airTax" value="${esc(row.airTax || "")}" /></td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="airTotalPrice" id="airTotalPrice" value="${esc(row.airTotalPrice || "")}" /></td>
            <td></td>
          </tr>
          <tr>
            <td class="label">海运</td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="seaWeightQty" id="seaWeightQty" value="${esc(row.seaWeightQty || "")}" readonly /></td>
            <td><input class="input calc" type="number" step="0.001" name="seaUnitPrice" id="seaUnitPrice" value="${esc(row.seaUnitPrice || "")}" /></td>
            <td><input class="input calc" type="number" step="0.001" name="seaTax" id="seaTax" value="${esc(row.seaTax || "")}" /></td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="seaTotalPrice" id="seaTotalPrice" value="${esc(row.seaTotalPrice || "")}" /></td>
            <td></td>
          </tr>
        </table>
      </div>

      <div class="white-gap"></div>

      <div class="section">
        <table class="layout">
          <colgroup>
            <col style="width: 220px;">
            <col style="width: 220px;">
            <col style="width: 220px;">
            <col style="width: 220px;">
            <col style="width: 220px;">
            <col style="width: 220px;">
          </colgroup>
          <tr>
            <td class="label">FBA费用(RMB)</td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="fbaFeeRmb" id="fbaFeeRmb" value="${esc(row.fbaFeeRmb || "")}" /></td>
            <td class="label">佣金(RMB)</td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="commissionRmb" id="commissionRmb" value="${esc(row.commissionRmb || "")}" /></td>
            <td class="label">退货成本(RMB)</td>
            <td><input class="input calc" type="number" step="0.001" name="returnCostRmb" id="returnCostRmb" value="${esc(row.returnCostRmb || "")}" /></td>
          </tr>
          <tr>
            <td class="label">仓租(USD)</td>
            <td><input class="input calc" type="number" step="0.001" name="warehouseUsd" id="warehouseUsd" value="${esc(row.warehouseUsd || "")}" /></td>
            <td class="label">配送+分拨(USD)</td>
            <td><input class="input calc" type="number" step="0.001" name="deliveryUsd" id="deliveryUsd" value="${esc(row.deliveryUsd || "")}" /></td>
            <td class="label">广告费(RMB)</td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="adCostRmb" id="adCostRmb" value="${esc(row.adCostRmb || "")}" /></td>
          </tr>
        </table>
      </div>

      <div class="submit-wrap">
        <button class="submit-btn" type="submit">${buttonText}</button>
      </div>
    </form>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);

    function num(id) {
      const el = $(id);
      if (!el) return 0;
      const v = parseFloat(el.value);
      return Number.isFinite(v) ? v : 0;
    }

    function setVal(id, value, digits = 3) {
      const el = $(id);
      if (!el) return;
      if (!Number.isFinite(value)) {
        el.value = "";
        return;
      }
      el.value = value.toFixed(digits);
    }

   function calcAll() {
  const exchangeRate = num("exchangeRate");
  const purchaseCost = num("purchaseCost");
  const commissionRate = num("commissionRate");
  const fenxiaoPrice = num("fenxiaoPrice");
  const adRate = num("adRate");
  const sellingPriceUsd = num("sellingPriceUsd");

  const length = num("lengthCm");
  const width = num("widthCm");
  const height = num("heightCm");
  const actualWeight = num("actualWeight");

  const expressUnitPrice = num("expressUnitPrice");
  const expressTax = $("expressTax").value === "" ? 1 : num("expressTax");

  const airUnitPrice = num("airUnitPrice");
  const airTax = $("airTax").value === "" ? 1 : num("airTax");

  const seaUnitPrice = num("seaUnitPrice");
  const seaTax = $("seaTax").value === "" ? 1 : num("seaTax");

  const fbaFeeRmb = num("fbaFeeRmb");
  const returnCostRmb = num("returnCostRmb");
  const warehouseUsd = num("warehouseUsd");
  const deliveryUsd = num("deliveryUsd");

  // 1) 销售价 RMB
  const sellingPriceRmb = sellingPriceUsd * exchangeRate;
  setVal("sellingPriceRmb", sellingPriceRmb);

  // 2) 分销利润
  const profitCostDiff = fenxiaoPrice - purchaseCost;
  setVal("profitCostDiff", profitCostDiff);

  const profitRate1 = fenxiaoPrice ? (profitCostDiff / fenxiaoPrice) * 100 : 0;
  setVal("profitRate1", profitRate1);

  const profitSellDiff = sellingPriceRmb - fenxiaoPrice;
  setVal("profitSellDiff", profitSellDiff);

  const profitRate2 = sellingPriceRmb ? (profitSellDiff / sellingPriceRmb) * 100 : 0;
  setVal("profitRate2", profitRate2);

  // 3) 体积重
  const volume6000 = (length * width * height) / 6000;
  const volume5000 = (length * width * height) / 5000;
  setVal("volumeWeight6000", volume6000);
  setVal("volumeWeight5000", volume5000);

  // 4) 计重数量
  // 快递 = 体重1
  // 空运 = 体重1
  // 海运 = 体重2
  const weight1 = Math.max(actualWeight, volume6000);
  const weight2 = Math.max(actualWeight, volume5000);

  setVal("expressWeightQty", weight1);
  setVal("airWeightQty", weight1);
  setVal("seaWeightQty", weight2);

  // 5) 价格 = 计重数量 * 单价 * 税费
  const expressTotalPrice = weight1 * expressUnitPrice * expressTax;
  const airTotalPrice = weight1 * airUnitPrice * airTax;
  const seaTotalPrice = weight2 * seaUnitPrice * seaTax;

  setVal("expressTotalPrice", expressTotalPrice);
  setVal("airTotalPrice", airTotalPrice);
  setVal("seaTotalPrice", seaTotalPrice);

  // 6) 上面运输方式后面的快递/空运/海运 = 下面的价格
  setVal("expressFee", expressTotalPrice);
  setVal("airFee", airTotalPrice);
  setVal("seaFee", seaTotalPrice);

  // 7) 佣金 = 销售价 * 佣金% * 汇率
  const commissionRmb = sellingPriceUsd * (commissionRate / 100) * exchangeRate;
  setVal("commissionRmb", commissionRmb);

  // 8) 广告费RMB = 广告费% * 销售价格USD
  const adCostRmb = sellingPriceUsd * (adRate / 100);
  setVal("adCostRmb", adCostRmb);

  // 9) 公共成本
  const commonCost =
    purchaseCost +
    fbaFeeRmb +
    commissionRmb +
    returnCostRmb +
    adCostRmb +
    warehouseUsd +
    deliveryUsd;

  // 10) 各运输利润
  const expressProfit = sellingPriceRmb - commonCost - expressTotalPrice;
  const airProfit = sellingPriceRmb - commonCost - airTotalPrice;
  const seaProfit = sellingPriceRmb - commonCost - seaTotalPrice;

  setVal("expressProfit", expressProfit);
  setVal("airProfit", airProfit);
  setVal("seaProfit", seaProfit);

  const expressProfitRate = sellingPriceRmb ? (expressProfit / sellingPriceRmb) * 100 : 0;
  const airProfitRate = sellingPriceRmb ? (airProfit / sellingPriceRmb) * 100 : 0;
  const seaProfitRate = sellingPriceRmb ? (seaProfit / sellingPriceRmb) * 100 : 0;

  setVal("expressProfitRate", expressProfitRate);
  setVal("airProfitRate", airProfitRate);
  setVal("seaProfitRate", seaProfitRate);

  // 11) 税费默认 1
  if ($("expressTax").value === "") $("expressTax").value = "1.000";
  if ($("airTax").value === "") $("airTax").value = "1.000";
  if ($("seaTax").value === "") $("seaTax").value = "1.000";

  // 12) 保存单价到浏览器，下次默认带出
  if ($("expressUnitPrice").value !== "") localStorage.setItem("expressUnitPrice", $("expressUnitPrice").value);
  if ($("airUnitPrice").value !== "") localStorage.setItem("airUnitPrice", $("airUnitPrice").value);
  if ($("seaUnitPrice").value !== "") localStorage.setItem("seaUnitPrice", $("seaUnitPrice").value);
}

async function fetchRate() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await res.json();

    if (data && data.rates && data.rates.CNY) {
      const realRate = Number(data.rates.CNY);
      const finalRate = realRate * 0.9;
      setVal("exchangeRate", finalRate, 4);
      calcAll();
    } else {
      alert("获取汇率失败");
    }
  } catch (err) {
    alert("获取汇率失败：" + err.message);
  }
}

    const fileInput = $("photoInput");
    const previewBox = $("photoPreviewBox");
    if (fileInput) {
      fileInput.addEventListener("change", function() {
        const file = this.files && this.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
          previewBox.innerHTML = '<img src="' + e.target.result + '" style="max-width:100%;max-height:100%;object-fit:contain;">';
        };
        reader.readAsDataURL(file);
      });
    }

    document.querySelectorAll(".calc").forEach(el => {
  el.addEventListener("input", calcAll);
});

window.addEventListener("DOMContentLoaded", () => {
  if (!$("expressUnitPrice").value) {
    $("expressUnitPrice").value = localStorage.getItem("expressUnitPrice") || "";
  }
  if (!$("airUnitPrice").value) {
    $("airUnitPrice").value = localStorage.getItem("airUnitPrice") || "";
  }
  if (!$("seaUnitPrice").value) {
    $("seaUnitPrice").value = localStorage.getItem("seaUnitPrice") || "";
  }

  if (!$("expressTax").value) $("expressTax").value = "1";
  if (!$("airTax").value) $("airTax").value = "1";
  if (!$("seaTax").value) $("seaTax").value = "1";

  calcAll();

  if (!$("exchangeRate").value) {
    fetchRate();
  }
});
  </script>
</body>
</html>
  `;
}

// 登录页
app.get("/login", (_req, res) => {
  res.send(renderLoginPage());
});

// 登录处理
app.post("/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "").trim();

  db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
    if (err || !user) {
      return res.send(renderLoginPage("用户名或密码错误"));
    }

    if (user.password_hash !== hashPassword(password)) {
      return res.send(renderLoginPage("用户名或密码错误"));
    }

    db.run(
      "UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?",
      [user.id]
    );

    req.session.user = {
      id: user.id,
      username: user.username,
      is_admin: !!user.is_admin
    };

    req.session.save(() => {
      res.redirect("/list");
    });
  });
});

// 注册页
app.get("/register", (_req, res) => {
  res.send(renderRegisterPage());
});

// 注册处理
app.post("/register", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "").trim();

  if (!username || !password) {
    return res.send(renderRegisterPage("用户名和密码不能为空"));
  }

  if (username.length < 3 || password.length < 4) {
    return res.send(renderRegisterPage("用户名至少3位，密码至少4位"));
  }

  db.run(
    "INSERT INTO users (username, password_hash, password_plain, is_admin) VALUES (?, ?, ?, 0)",
    [username, hashPassword(password), password],
    function (err) {
      if (err) {
        return res.send(renderRegisterPage("用户名已存在，请换一个"));
      }
      res.redirect("/login");
    }
  );
});

// 退出
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// 新增表单页面
app.get("/", checkLogin, (req, res) => {
  res.send(renderFormPage({ mode: "create", user: req.session.user }));
});

app.get("/form", checkLogin, (req, res) => {
  res.send(renderFormPage({ mode: "create", user: req.session.user }));
});

// 保存新产品
app.post("/save", checkLogin, upload.single("photo"), (req, res) => {
  const d = req.body;
  const u = req.session.user;
  const photoPath = req.file ? req.file.filename : "";

  generateProductCode((codeErr, autoCode) => {
    if (codeErr) {
      return res.send("生成产品编号失败：" + codeErr.message);
    }

    d.productCode = autoCode;

    const sql = `
      INSERT INTO products (
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
        ?, ?, ?, ?, ?,
        datetime('now','localtime'), datetime('now','localtime')
      )
    `;

    const values = [
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
      photoPath,
      u.id,
      u.username,
      u.id,
      u.username
    ];

    db.run(sql, values, function (err) {
      if (err) {
        return res.send("保存失败：" + err.message);
      }

      db.run(
        "UPDATE users SET last_edit_at = datetime('now','localtime') WHERE id = ?",
        [u.id]
      );

      res.redirect("/detail/" + this.lastID);
    });
  });
});
// 列表
app.get("/list", checkLogin, (req, res) => {
  const user = req.session.user;

  const keyword = String(req.query.keyword || "").trim(); // 产品名称搜索
  const filterUser = String(req.query.filterUser || "").trim(); // 管理员按用户筛选
  const dateMode = String(req.query.dateMode || "all").trim(); // all / today / range
  const startDate = String(req.query.startDate || "").trim();
  const endDate = String(req.query.endDate || "").trim();

  let whereSql = " WHERE 1=1 ";
  const params = [];

  // 普通用户只能看自己的
  if (!user.is_admin) {
    whereSql += " AND ownerUserId = ? ";
    params.push(user.id);
  }

  // 产品名称搜索
  if (keyword) {
    whereSql += " AND productName LIKE ? ";
    params.push(`%${keyword}%`);
  }

  // 管理员按用户搜索
  if (user.is_admin && filterUser) {
    whereSql += " AND ownerUsername LIKE ? ";
    params.push(`%${filterUser}%`);
  }

  // 日期筛选
  if (dateMode === "today") {
    whereSql += " AND date(updatedAt) = date('now','localtime') ";
  } else if (dateMode === "range" && startDate && endDate) {
    whereSql += " AND date(updatedAt) >= date(?) AND date(updatedAt) <= date(?) ";
    params.push(startDate, endDate);
  }

  const sql = `
    SELECT * FROM products
    ${whereSql}
    ORDER BY datetime(updatedAt) DESC, id DESC
  `;

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.send("读取失败：" + err.message);
    }

    const exportParams = new URLSearchParams();
    if (keyword) exportParams.set("keyword", keyword);
    if (filterUser) exportParams.set("filterUser", filterUser);
    if (dateMode) exportParams.set("dateMode", dateMode);
    if (startDate) exportParams.set("startDate", startDate);
    if (endDate) exportParams.set("endDate", endDate);

    res.send(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <title>Product Development Record Sheet - 列表</title>
        <style>
          body {
            font-family: Arial, "Microsoft YaHei", sans-serif;
            padding: 20px;
            background: #ffffff;
          }
          a { text-decoration: none; color: blue; }
          table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            margin-top: 20px;
          }
          th, td {
            border: 1px solid #ccc;
            padding: 10px;
            text-align: left;
            font-size: 14px;
          }
          th { background: #f1f1f1; }
          input, select {
            padding: 8px;
            margin-right: 8px;
          }
          button {
            padding: 8px 14px;
            background: #2f6fed;
            color: white;
            border: none;
            cursor: pointer;
            border-radius: 4px;
            margin-right: 8px;
          }
          .filter-row {
            margin-top: 10px;
            margin-bottom: 10px;
          }
        </style>
      </head>
      <body>
        <h1>Product Development Record Sheet</h1>
        ${renderTopButtons(user)}

        <form method="GET" action="/list">
          <div class="filter-row">
            <input
              type="text"
              name="keyword"
              placeholder="按产品名称搜索"
              value="${esc(keyword)}"
              style="width:220px;"
            >

            ${
              user.is_admin
                ? `
                <input
                  type="text"
                  name="filterUser"
                  placeholder="按用户名称搜索"
                  value="${esc(filterUser)}"
                  style="width:180px;"
                >
                `
                : ""
            }

            <select name="dateMode" id="dateMode" onchange="toggleDateRange()">
              <option value="all" ${dateMode === "all" ? "selected" : ""}>所有日期</option>
              <option value="today" ${dateMode === "today" ? "selected" : ""}>今天</option>
              <option value="range" ${dateMode === "range" ? "selected" : ""}>日期范围</option>
            </select>

            <span id="dateRangeBox" style="${dateMode === "range" ? "" : "display:none;"}">
              <input type="date" name="startDate" value="${esc(startDate)}">
              <input type="date" name="endDate" value="${esc(endDate)}">
            </span>

            <button type="submit">搜索</button>
            <a href="/list" style="margin-right:12px;">清空条件</a>
            <a href="/export-excel?${exportParams.toString()}" style="margin-right:12px;">导出 Excel</a>
            <a href="/export-pdf?${exportParams.toString()}">导出 PDF</a>
          </div>
        </form>

        <table>
          <tr>
            <th>ID</th>
            <th>表单名称</th>
            <th>产品名称</th>
            <th>产品编号</th>
            <th>采购成本</th>
            <th>销售价USD</th>
            ${user.is_admin ? "<th>创建人</th><th>最后编辑人</th>" : ""}
            <th>最后更新时间</th>
            <th>操作</th>
          </tr>
          ${
            rows.length > 0
              ? rows.map(row => `
                <tr>
                  <td><a href="/detail/${row.id}">${row.id}</a></td>
                  <td><a href="/detail/${row.id}">${esc(row.formName)}</a></td>
                  <td>${esc(row.productName)}</td>
                  <td>${esc(row.productCode)}</td>
                  <td>${esc(row.purchaseCost)}</td>
                  <td>${esc(row.sellingPriceUsd)}</td>
                  ${user.is_admin ? `<td>${esc(row.ownerUsername)}</td><td>${esc(row.lastEditedByUsername)}</td>` : ""}
                  <td>${esc(formatTime(row.updatedAt))}</td>
                  <td>
                    <a href="/edit/${row.id}">编辑</a>
                    &nbsp;|&nbsp;
                    <a href="/delete/${row.id}" onclick="return confirm('确定删除吗？')">删除</a>
                  </td>
                </tr>
              `).join("")
              : `<tr><td colspan="${user.is_admin ? 9 : 7}" style="text-align:center;">暂无记录</td></tr>`
          }
        </table>

        <script>
          function toggleDateRange() {
            const mode = document.getElementById("dateMode").value;
            document.getElementById("dateRangeBox").style.display =
              mode === "range" ? "inline-block" : "none";
          }
        </script>
      </body>
      </html>
    `);
  });
});

function queryProductForUser(id, user, callback) {
  let sql = "SELECT * FROM products WHERE id = ?";
  const params = [id];

  if (!user.is_admin) {
    sql += " AND ownerUserId = ?";
    params.push(user.id);
  }

  db.get(sql, params, callback);
}

// 详情
app.get("/detail/:id", checkLogin, (req, res) => {
  queryProductForUser(req.params.id, req.session.user, (err, row) => {
    if (err || !row) {
      return res.send("找不到数据");
    }

    const adminInfo = req.session.user.is_admin
      ? `
        <p><strong>创建人：</strong>${esc(row.ownerUsername)}</p>
        <p><strong>最后编辑人：</strong>${esc(row.lastEditedByUsername)}</p>
      `
      : "";

    const photoBlock = row.photoPath
      ? `<p><img src="/uploads/${esc(row.photoPath)}" style="max-width:420px;border:1px solid #ccc;"></p>`
      : `<p><strong>照片：</strong>无</p>`;

    const fields = [
      ["表单名称", row.formName],
      ["产品名称", row.productName],
      ["产品编号", row.productCode],
      ["汇率", row.exchangeRate],
      ["采购成本", row.purchaseCost],
      ["佣金", row.commissionRate],
      ["分销价", row.fenxiaoPrice],
      ["广告费", row.adRate],
      ["分销减采购成本利润", row.profitCostDiff],
      ["利润率1", row.profitRate1],
      ["销售价USD", row.sellingPriceUsd],
      ["销售价RMB", row.sellingPriceRmb],
      ["销售价-分销价利润", row.profitSellDiff],
      ["利润率2", row.profitRate2],
      ["备注", row.remark],
      ["包装方式", row.packageType],
      ["体积重6000", row.volumeWeight6000],
      ["体积重5000", row.volumeWeight5000],
      ["实重", row.actualWeight],
      ["长", row.lengthCm],
      ["宽", row.widthCm],
      ["高", row.heightCm],
      ["快递费用", row.expressFee],
      ["快递利润", row.expressProfit],
      ["快递利润率", row.expressProfitRate],
      ["空运费用", row.airFee],
      ["空运利润", row.airProfit],
      ["空运利润率", row.airProfitRate],
      ["海运费用", row.seaFee],
      ["海运利润", row.seaProfit],
      ["海运利润率", row.seaProfitRate],
      ["快递计重数量", row.expressWeightQty],
      ["快递单价", row.expressUnitPrice],
      ["快递税费", row.expressTax],
      ["快递价格", row.expressTotalPrice],
      ["空运计重数量", row.airWeightQty],
      ["空运单价", row.airUnitPrice],
      ["空运税费", row.airTax],
      ["空运价格", row.airTotalPrice],
      ["海运计重数量", row.seaWeightQty],
      ["海运单价", row.seaUnitPrice],
      ["海运税费", row.seaTax],
      ["海运价格", row.seaTotalPrice],
      ["FBA费用(RMB)", row.fbaFeeRmb],
      ["佣金(RMB)", row.commissionRmb],
      ["退货成本(RMB)", row.returnCostRmb],
      ["仓租(USD)", row.warehouseUsd],
      ["配送+分拨(USD)", row.deliveryUsd],
      ["广告费(RMB)", row.adCostRmb],
      ["创建时间", row.createdAt],
      ["最后更新时间", row.updatedAt]
    ];

    let items = photoBlock;
    fields.forEach(([label, value]) => {
      items += `<p><strong>${esc(label)}：</strong>${esc(value)}</p>`;
    });

    res.send(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <title>Product Development Record Sheet - 详情</title>
        <style>
          body { font-family: Arial,"Microsoft YaHei"; padding:20px; background:#ffffff; }
          .box { background:white; padding:20px; border:1px solid #ddd; }
          p { margin: 8px 0; }
          a { color: blue; text-decoration: none; }
        </style>
      </head>
      <body>
        <h1>Product Development Record Sheet</h1>
        ${renderTopButtons(req.session.user)}
        <p><a href="/edit/${row.id}">编辑这条记录</a></p>
        <div class="box">
          ${adminInfo}
          ${items}
        </div>
      </body>
      </html>
    `);
  });
});

// 编辑页
app.get("/edit/:id", checkLogin, (req, res) => {
  queryProductForUser(req.params.id, req.session.user, (err, row) => {
    if (err || !row) {
      return res.send("找不到要编辑的数据");
    }
    res.send(renderFormPage({ mode: "edit", user: req.session.user, row }));
  });
});

// 更新保存
app.post("/update/:id", checkLogin, upload.single("photo"), (req, res) => {
  const id = req.params.id;
  const user = req.session.user;

  queryProductForUser(id, user, (err, oldRow) => {
    if (err || !oldRow) {
      return res.send("找不到要更新的数据");
    }

    let newPhotoPath = oldRow.photoPath || "";
    if (req.file) {
      if (oldRow.photoPath) {
        deletePhotoFile(oldRow.photoPath);
      }
      newPhotoPath = req.file.filename;
    }

    const d = req.body;

    const sql = `
      UPDATE products SET
        formName = ?, productName = ?, productCode = ?, exchangeRate = ?, purchaseCost = ?, commissionRate = ?,
        fenxiaoPrice = ?, adRate = ?, profitCostDiff = ?, profitRate1 = ?,
        sellingPriceUsd = ?, sellingPriceRmb = ?, profitSellDiff = ?, profitRate2 = ?,
        remark = ?, packageType = ?,
        volumeWeight6000 = ?, volumeWeight5000 = ?, actualWeight = ?, lengthCm = ?, widthCm = ?, heightCm = ?,
        expressFee = ?, expressProfit = ?, expressProfitRate = ?,
        airFee = ?, airProfit = ?, airProfitRate = ?,
        seaFee = ?, seaProfit = ?, seaProfitRate = ?,
        expressWeightQty = ?, expressUnitPrice = ?, expressTax = ?, expressTotalPrice = ?,
        airWeightQty = ?, airUnitPrice = ?, airTax = ?, airTotalPrice = ?,
        seaWeightQty = ?, seaUnitPrice = ?, seaTax = ?, seaTotalPrice = ?,
        fbaFeeRmb = ?, commissionRmb = ?, returnCostRmb = ?, warehouseUsd = ?, deliveryUsd = ?, adCostRmb = ?,
        photoPath = ?, lastEditedByUserId = ?, lastEditedByUsername = ?, updatedAt = datetime('now','localtime')
      WHERE id = ?
    `;

    const values = [
      d.formName || "", d.productName || "", d.productCode || "", d.exchangeRate || "", d.purchaseCost || "", d.commissionRate || "",
      d.fenxiaoPrice || "", d.adRate || "", d.profitCostDiff || "", d.profitRate1 || "",
      d.sellingPriceUsd || "", d.sellingPriceRmb || "", d.profitSellDiff || "", d.profitRate2 || "",
      d.remark || "", d.packageType || "",
      d.volumeWeight6000 || "", d.volumeWeight5000 || "", d.actualWeight || "", d.lengthCm || "", d.widthCm || "", d.heightCm || "",
      d.expressFee || "", d.expressProfit || "", d.expressProfitRate || "",
      d.airFee || "", d.airProfit || "", d.airProfitRate || "",
      d.seaFee || "", d.seaProfit || "", d.seaProfitRate || "",
      d.expressWeightQty || "", d.expressUnitPrice || "", d.expressTax || "", d.expressTotalPrice || "",
      d.airWeightQty || "", d.airUnitPrice || "", d.airTax || "", d.airTotalPrice || "",
      d.seaWeightQty || "", d.seaUnitPrice || "", d.seaTax || "", d.seaTotalPrice || "",
      d.fbaFeeRmb || "", d.commissionRmb || "", d.returnCostRmb || "", d.warehouseUsd || "", d.deliveryUsd || "", d.adCostRmb || "",
      newPhotoPath, user.id, user.username, id
    ];

    db.run(sql, values, function(updateErr) {
      if (updateErr) {
        return res.send("更新失败：" + updateErr.message);
      }

      db.run(
        "UPDATE users SET last_edit_at = datetime('now','localtime') WHERE id = ?",
        [user.id]
      );

      res.redirect("/detail/" + id);
    });
  });
});

// 删除照片
app.get("/delete-photo/:id", checkLogin, (req, res) => {
  const id = req.params.id;
  queryProductForUser(id, req.session.user, (err, row) => {
    if (err || !row) {
      return res.send("找不到记录");
    }
    if (row.photoPath) {
      deletePhotoFile(row.photoPath);
    }
    db.run(
      "UPDATE products SET photoPath = '', lastEditedByUserId = ?, lastEditedByUsername = ?, updatedAt = datetime('now','localtime') WHERE id = ?",
      [req.session.user.id, req.session.user.username, id],
      (e) => {
        if (e) return res.send("删除照片失败：" + e.message);

        db.run(
          "UPDATE users SET last_edit_at = datetime('now','localtime') WHERE id = ?",
          [req.session.user.id]
        );

        res.redirect("/edit/" + id);
      }
    );
  });
});

// 删除记录
app.get("/delete/:id", checkLogin, (req, res) => {
  queryProductForUser(req.params.id, req.session.user, (err, row) => {
    if (err || !row) {
      return res.send("找不到要删除的记录");
    }

    if (row.photoPath) {
      deletePhotoFile(row.photoPath);
    }

    db.run("DELETE FROM products WHERE id = ?", [req.params.id], (e) => {
      if (e) return res.send("删除失败：" + e.message);

      db.run(
        "UPDATE users SET last_edit_at = datetime('now','localtime') WHERE id = ?",
        [req.session.user.id]
      );

      res.redirect("/list");
    });
  });
});

// 用户列表（管理员）

app.get("/export-excel", checkLogin, (req, res) => {
  const user = req.session.user;

  const keyword = String(req.query.keyword || "").trim();
  const filterUser = String(req.query.filterUser || "").trim();
  const dateMode = String(req.query.dateMode || "all").trim();
  const startDate = String(req.query.startDate || "").trim();
  const endDate = String(req.query.endDate || "").trim();

  let whereSql = " WHERE 1=1 ";
  const params = [];

  if (!user.is_admin) {
    whereSql += " AND ownerUserId = ? ";
    params.push(user.id);
  }

  if (keyword) {
    whereSql += " AND productName LIKE ? ";
    params.push(`%${keyword}%`);
  }

  if (user.is_admin && filterUser) {
    whereSql += " AND ownerUsername LIKE ? ";
    params.push(`%${filterUser}%`);
  }

  if (dateMode === "today") {
    whereSql += " AND date(updatedAt) = date('now','localtime') ";
  } else if (dateMode === "range" && startDate && endDate) {
    whereSql += " AND date(updatedAt) >= date(?) AND date(updatedAt) <= date(?) ";
    params.push(startDate, endDate);
  }

  const sql = `
    SELECT id, formName, productName, productCode, purchaseCost, sellingPriceUsd,
           ownerUsername, lastEditedByUsername, createdAt, updatedAt
    FROM products
    ${whereSql}
    ORDER BY datetime(updatedAt) DESC, id DESC
  `;

  db.all(sql, params, (err, rows) => {
  if (err) {
    return res.send("导出失败：" + err.message);
  }

  const wb = XLSX.utils.book_new();

  rows.forEach((row) => {
    const data = [
      ["Product Development Record Sheet"],
      [],
      ["基本信息", "", "", "", "", ""],
      ["表单名称", row.formName || "", "产品名称", row.productName || "", "", ""],
      ["产品编号", row.productCode || "", "汇率", row.exchangeRate || "", "", ""],
      ["采购成本(RMB)", row.purchaseCost || "", "佣金(%)", row.commissionRate || "", "", ""],
      ["分销价", row.fenxiaoPrice || "", "广告费(%)", row.adRate || "", "", ""],
      ["分销减采购成本利润", row.profitCostDiff || "", "利润率1(%)", row.profitRate1 || "", "", ""],
      ["销售价(USD)", row.sellingPriceUsd || "", "销售价(RMB)", row.sellingPriceRmb || "", "", ""],
      ["销售价-分销价利润", row.profitSellDiff || "", "利润率2(%)", row.profitRate2 || "", "", ""],
      ["备注", row.remark || "", "", "", "", ""],
      [],
      ["包装信息", "", "", "", "", ""],
      ["包装方式", row.packageType || "", "实重", row.actualWeight || "", "", ""],
      ["长(CM)", row.lengthCm || "", "宽(CM)", row.widthCm || "", "高(CM)", row.heightCm || ""],
      ["体积重1(/6000)", row.volumeWeight6000 || "", "体积重2(/5000)", row.volumeWeight5000 || "", "", ""],
      [],
      ["运输信息", "", "", "", "", ""],
      ["快递价格", row.expressTotalPrice || "", "快递利润", row.expressProfit || "", "快递利润率", row.expressProfitRate || ""],
      ["空运价格", row.airTotalPrice || "", "空运利润", row.airProfit || "", "空运利润率", row.airProfitRate || ""],
      ["海运价格", row.seaTotalPrice || "", "海运利润", row.seaProfit || "", "海运利润率", row.seaProfitRate || ""],
      [],
      ["其他费用", "", "", "", "", ""],
      ["FBA费用(RMB)", row.fbaFeeRmb || "", "佣金(RMB)", row.commissionRmb || "", "", ""],
      ["退货成本(RMB)", row.returnCostRmb || "", "仓租(USD)", row.warehouseUsd || "", "", ""],
      ["配送+分拨(USD)", row.deliveryUsd || "", "广告费(RMB)", row.adCostRmb || "", "", ""],
      [],
      ["记录信息", "", "", "", "", ""],
      ["创建人", row.ownerUsername || "", "最后编辑人", row.lastEditedByUsername || "", "", ""],
      ["创建时间", row.createdAt || "", "最后更新时间", row.updatedAt || "", "", ""]
    ];

    const ws = XLSX.utils.aoa_to_sheet(data);

    ws["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 5 } },
      { s: { r: 10, c: 1 }, e: { r: 10, c: 5 } },
      { s: { r: 12, c: 0 }, e: { r: 12, c: 5 } },
      { s: { r: 17, c: 0 }, e: { r: 17, c: 5 } },
      { s: { r: 22, c: 0 }, e: { r: 22, c: 5 } },
      { s: { r: 27, c: 0 }, e: { r: 27, c: 5 } }
    ];

    ws["!cols"] = [
      { wch: 18 },
      { wch: 22 },
      { wch: 18 },
      { wch: 22 },
      { wch: 18 },
      { wch: 22 }
    ];

    XLSX.utils.book_append_sheet(wb, ws, `表单_${row.id}`.slice(0, 31));
  });

  if (rows.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([["没有可导出的记录"]]);
    XLSX.utils.book_append_sheet(wb, ws, "Products");
  }

  const fileName = `products_${Date.now()}.xlsx`;
  const filePath = path.join(ROOT, fileName);

  XLSX.writeFile(wb, filePath);

  res.download(filePath, fileName, (downloadErr) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (downloadErr) console.error(downloadErr);
  });
});
});

app.get("/export-pdf", checkLogin, (req, res) => {
  const user = req.session.user;

  const keyword = String(req.query.keyword || "").trim();
  const filterUser = String(req.query.filterUser || "").trim();
  const dateMode = String(req.query.dateMode || "all").trim();
  const startDate = String(req.query.startDate || "").trim();
  const endDate = String(req.query.endDate || "").trim();

  let whereSql = " WHERE 1=1 ";
  const params = [];

  if (!user.is_admin) {
    whereSql += " AND ownerUserId = ? ";
    params.push(user.id);
  }

  if (keyword) {
    whereSql += " AND productName LIKE ? ";
    params.push(`%${keyword}%`);
  }

  if (user.is_admin && filterUser) {
    whereSql += " AND ownerUsername LIKE ? ";
    params.push(`%${filterUser}%`);
  }

  if (dateMode === "today") {
    whereSql += " AND date(updatedAt) = date('now','localtime') ";
  } else if (dateMode === "range" && startDate && endDate) {
    whereSql += " AND date(updatedAt) >= date(?) AND date(updatedAt) <= date(?) ";
    params.push(startDate, endDate);
  }

  const sql = `
  SELECT *
  FROM products
  ${whereSql}
  ORDER BY datetime(updatedAt) DESC, id DESC
`;

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.send("导出失败：" + err.message);
    }

    res.setHeader("Content-Type", "application/pdf");
res.setHeader("Content-Disposition", `attachment; filename="products_${Date.now()}.pdf"`);

const doc = new PDFDocument({ margin: 30, size: "A4" });
doc.font(path.join(ROOT, "NotoSansCJKsc-Regular.otf"));
doc.pipe(res);

function drawField(label, value, x, y, w = 250) {
  doc.fontSize(10).text(label, x, y, { width: 80 });
  doc.rect(x + 80, y - 2, w - 80, 18).stroke();
  doc.fontSize(10).text(String(value || ""), x + 85, y + 3, { width: w - 90 });
}

function drawSectionTitle(title, y) {
  doc.rect(30, y, 535, 20).fillAndStroke("#e0e0e0", "#999999");
  doc.fillColor("#000").fontSize(12).text(title, 35, y + 5);
}

if (rows.length === 0) {
  doc.fontSize(14).text("没有可导出的记录", { align: "center" });
  doc.end();
  return;
}

rows.forEach((row, index) => {
  if (index > 0) doc.addPage();

  let y = 30;

  doc.fontSize(18).text("Product Development Record Sheet", 30, y, {
    width: 535,
    align: "center"
  });
  y += 30;

  drawSectionTitle("基本信息", y);
  y += 30;
  drawField("表单名称", row.formName, 30, y, 260);
  drawField("产品名称", row.productName, 305, y, 260);
  y += 28;
  drawField("产品编号", row.productCode, 30, y, 260);
  drawField("汇率", row.exchangeRate, 305, y, 260);
  y += 28;
  drawField("采购成本", row.purchaseCost, 30, y, 260);
  drawField("佣金(%)", row.commissionRate, 305, y, 260);
  y += 28;
  drawField("分销价", row.fenxiaoPrice, 30, y, 260);
  drawField("广告费(%)", row.adRate, 305, y, 260);
  y += 28;
  drawField("利润1", row.profitCostDiff, 30, y, 260);
  drawField("利润率1", row.profitRate1, 305, y, 260);
  y += 28;
  drawField("销售价USD", row.sellingPriceUsd, 30, y, 260);
  drawField("销售价RMB", row.sellingPriceRmb, 305, y, 260);
  y += 28;
  drawField("利润2", row.profitSellDiff, 30, y, 260);
  drawField("利润率2", row.profitRate2, 305, y, 260);
  y += 35;

  drawSectionTitle("包装信息", y);
  y += 30;
  drawField("包装方式", row.packageType, 30, y, 260);
  drawField("实重", row.actualWeight, 305, y, 260);
  y += 28;
  drawField("长(CM)", row.lengthCm, 30, y, 170);
  drawField("宽(CM)", row.widthCm, 210, y, 170);
  drawField("高(CM)", row.heightCm, 390, y, 175);
  y += 28;
  drawField("体积重6000", row.volumeWeight6000, 30, y, 260);
  drawField("体积重5000", row.volumeWeight5000, 305, y, 260);
  y += 35;

  drawSectionTitle("运输信息", y);
  y += 30;
  drawField("快递价格", row.expressTotalPrice, 30, y, 170);
  drawField("快递利润", row.expressProfit, 210, y, 170);
  drawField("快递利润率", row.expressProfitRate, 390, y, 175);
  y += 28;
  drawField("空运价格", row.airTotalPrice, 30, y, 170);
  drawField("空运利润", row.airProfit, 210, y, 170);
  drawField("空运利润率", row.airProfitRate, 390, y, 175);
  y += 28;
  drawField("海运价格", row.seaTotalPrice, 30, y, 170);
  drawField("海运利润", row.seaProfit, 210, y, 170);
  drawField("海运利润率", row.seaProfitRate, 390, y, 175);
  y += 35;

  drawSectionTitle("其他费用", y);
  y += 30;
  drawField("FBA费用", row.fbaFeeRmb, 30, y, 260);
  drawField("佣金RMB", row.commissionRmb, 305, y, 260);
  y += 28;
  drawField("退货成本", row.returnCostRmb, 30, y, 260);
  drawField("仓租USD", row.warehouseUsd, 305, y, 260);
  y += 28;
  drawField("配送+分拨", row.deliveryUsd, 30, y, 260);
  drawField("广告费RMB", row.adCostRmb, 305, y, 260);
  y += 35;

  drawSectionTitle("记录信息", y);
  y += 30;
  drawField("创建人", row.ownerUsername, 30, y, 260);
  drawField("最后编辑人", row.lastEditedByUsername, 305, y, 260);
  y += 28;
  drawField("创建时间", row.createdAt, 30, y, 260);
  drawField("最后更新时间", row.updatedAt, 305, y, 260);
  y += 28;
  drawField("备注", row.remark, 30, y, 535);
});

doc.end();
  });
});

app.get("/users", checkLogin, checkAdmin, (_req, res) => {
  db.all(
    "SELECT id, username, password_plain, is_admin, created_at, last_login_at, last_edit_at FROM users ORDER BY id ASC",
    [],
    (err, rows) => {
      if (err) {
        return res.send("读取用户失败：" + err.message);
      }

      res.send(`
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <title>Product Development Record Sheet - 用户列表</title>
          <style>
            body { font-family: Arial,"Microsoft YaHei"; padding:20px; background:#fff; }
            table { width:100%; border-collapse:collapse; margin-top:20px; }
            th,td { border:1px solid #ccc; padding:10px; text-align:left; }
            th { background:#f1f1f1; }
            a { color:blue; text-decoration:none; }
          </style>
        </head>
        <body>
          <h1>Product Development Record Sheet</h1>
          ${renderTopButtons({ is_admin: true })}
          <table>
            <tr>
              <th>ID</th>
              <th>用户名</th>
              <th>密码</th>
              <th>角色</th>
              <th>注册时间</th>
              <th>最后登录时间</th>
              <th>最后编辑时间</th>
              <th>操作</th>
            </tr>
            ${rows.map(row => `
             <tr>
  <td>${row.id}</td>
  <td>${esc(row.username)}</td>
  <td>${esc(row.password_plain)}</td>
  <td>${row.is_admin ? "管理员" : "普通用户"}</td>
  <td>${esc(formatTimeCN(row.created_at))}</td>
  <td>${esc(formatTimeCN(row.last_login_at))}</td>
  <td>${esc(formatTimeCN(row.last_edit_at))}</td>
  <td>
    ${row.is_admin ? "" : `<a href="/delete-user/${row.id}" onclick="return confirm('确定删除这个用户吗？')">删除用户</a>`}
  </td>
</tr>
            `).join("")}
          </table>
        </body>
        </html>
      `);
    }
  );
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("服务器已启动：" + PORT);
});
