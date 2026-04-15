const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();
const session = require("express-session");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const XLSX = require("xlsx");
const cron = require("node-cron");
const axios = require("axios");
const app = express();
console.log("RUNNING APP FILE:", __filename);
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
  const day = String(now.getDate()).padStart(2, "0");
  const prefix = `${year}${month}${day}`;

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

function serverSizeTierLabel(code) {
  const map = {
    small_standard: "小号标准尺寸",
    large_standard: "大号标准尺寸",
    small_bulky: "小号大件",
    large_bulky: "大号大件",
    oversize_0_50: "超大件 0-50磅",
    oversize_50_70: "超大件 50-70磅",
    oversize_70_150: "超大件 70-150磅",
    oversize_150_plus: "超大件 150磅以上"
  };
  return map[code] || "";
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
      u.id as userId,
      u.username,
      COUNT(p.id) as totalAdded,
      SUM(CASE WHEN p.approveStatus='approved' THEN 1 ELSE 0 END) as totalApproved
    FROM users u
    LEFT JOIN products p
      ON u.id = p.ownerUserId
      AND p.createdAt BETWEEN ? AND ?
    WHERE u.is_admin = 0
    GROUP BY u.id, u.username
    ORDER BY u.username
    `,
    [startStr, endStr],
    (err, rows) => {
      if (err) return callback(err);

      const pdfName = `weekly-summary-${Date.now()}.pdf`;
      const pdfPath = path.join(ROOT, pdfName);
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      const fontPath = path.join(ROOT, "NotoSansCJKsc-Regular.otf");
      if (fs.existsSync(fontPath)) {
      doc.font(fontPath);
}
      doc.fontSize(20).text("每周产品汇总", { align: "center" });
      doc.moveDown();

      rows.forEach((row, index) => {
        const totalAdded = Number(row.totalAdded || 0);
        const totalApproved = Number(row.totalApproved || 0);
        const rate = totalAdded
          ? ((totalApproved / totalAdded) * 100).toFixed(2) + "%"
          : "0%";

        doc.fontSize(14).text(`用户${index + 1} ID：${row.username}`);
        doc.text(`增加产品表单数量：${totalAdded}`);
        doc.text(`通过的数量：${totalApproved}`);
        doc.text(`通过的百分比：${rate}`);
        db.all(
  `SELECT productName FROM products 
   WHERE ownerUserId=? 
   AND approveStatus='approved' 
   AND createdAt BETWEEN ? AND ?`,
  [row.userId, startStr, endStr],
  (e2, list)=>{
    const names = (list||[]).map(x=>x.productName).join("、") || "无";
    doc.text(`通过的产品：${names}`);
  }
);
        doc.moveDown();
      });

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

  db.run(`ALTER TABLE users ADD COLUMN approval_status TEXT DEFAULT 'pending'`, ()=>{});
  db.run(`ALTER TABLE users ADD COLUMN approved_by TEXT`, ()=>{});
  db.run(`ALTER TABLE users ADD COLUMN approved_at TEXT`, ()=>{});
  db.run(`ALTER TABLE users ADD COLUMN reject_reason TEXT`, ()=>{});

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

productSize TEXT,

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
      returnRate TEXT,
      warehouseUsd TEXT,
      deliveryUsd TEXT,
      adCostRmb TEXT,
      storageRateUsd TEXT,
      amazonReturnCostRmb TEXT,
      returnCostByRateRmb TEXT,
      photoPath TEXT,
      ownerUserId INTEGER,
      ownerUsername TEXT,
      lastEditedByUserId INTEGER,
      lastEditedByUsername TEXT,

      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

db.run(`ALTER TABLE products ADD COLUMN approveStatus TEXT DEFAULT 'pending'`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN returnRate TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN approvedBy TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN approvedAt TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN rejectReason TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN storageRateUsd TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN amazonReturnCostRmb TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN returnCostByRateRmb TEXT`, ()=>{});

// 竞品信息先用 3 组最简单，别一开始搞太复杂
db.run(`ALTER TABLE products ADD COLUMN competitor1Name TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor1Link TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor1Image TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor1Price TEXT`, ()=>{});

db.run(`ALTER TABLE products ADD COLUMN competitor2Name TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor2Link TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor2Image TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor2Price TEXT`, ()=>{});

db.run(`ALTER TABLE products ADD COLUMN competitor3Name TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor3Link TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor3Image TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor3Price TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor4Name TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor4Link TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor4Image TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor4Price TEXT`, ()=>{});

db.run(`ALTER TABLE products ADD COLUMN competitor5Name TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor5Link TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor5Image TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN competitor5Price TEXT`, ()=>{});

// 为了按图片规则计算，必须补一个尺寸分段字段
db.run(`ALTER TABLE products ADD COLUMN sizeTier TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN changedFields TEXT`, ()=>{});
db.run(`ALTER TABLE products ADD COLUMN productSize TEXT`, ()=>{});
  
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

db.get("SELECT * FROM users WHERE username = ?", ["dollywu"], (err, row) => {
  if (err) {
    console.error(err);
    return;
  }
  if (!row) {
    db.run(
      `INSERT INTO users
       (username, password_hash, password_plain, is_admin, approval_status, approved_by, approved_at)
       VALUES (?, ?, ?, 1, 'approved', 'system', datetime('now','localtime'))`,
      ["dollywu", hashPassword("bsq84049977"), "bsq84049977"],
      (e) => {
        if (e) console.error(e);
      }
    );
  } else {
    db.run(
      `UPDATE users
       SET is_admin = 1,
           approval_status = 'approved',
           approved_by = 'system',
           approved_at = COALESCE(approved_at, datetime('now','localtime'))
       WHERE username = ?`,
      ["dollywu"],
      (e) => {
        if (e) console.error(e);
      }
    );
  }
});

  db.run(
  `UPDATE users
   SET is_admin = 0,
       approval_status = 'approved'
   WHERE username = ?`,
  ["gly123"],
  (e) => {
    if (e) console.error("降级 gly123 失败:", e);
  }
);

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

app.get("/approve-user/:id", checkLogin, checkAdmin, (req, res) => {
  const id = req.params.id;
  db.run(
    `UPDATE users SET approval_status='approved', approved_by=?, approved_at=datetime('now','localtime') WHERE id=?`,
    [req.session.user.username, id],
    () => {
      res.redirect("/users");
    }
  );
});

app.get("/reject-user/:id", checkLogin, checkAdmin, (req, res) => {
  const id = req.params.id;
  db.run(
    `UPDATE users SET approval_status='rejected' WHERE id=?`,
    [id],
    () => {
      res.redirect("/users");
    }
  );
});

app.get("/user-products/:userId", checkLogin, checkAdmin, (req, res) => {
  const userId = req.params.userId;

  db.all("SELECT * FROM products WHERE ownerUserId = ?", [userId], (err, rows) => {
    if (err) return res.send(err.message);

    let html = "<h2>该用户的产品</h2>";

    rows.forEach(r => {
      html += `<div>
        ${r.productName || ""}
        <a href="/detail/${r.id}">查看</a>
      </div>`;
    });

    res.send(html);
  });
});

app.get("/approve-product/:id", checkLogin, checkAdmin, (req, res) => {
  const id = req.params.id;

  db.run(
    `UPDATE products SET approveStatus='approved', approvedBy=?, approvedAt=datetime('now','localtime') WHERE id=?`,
    [req.session.user.username, id],
    () => {
      res.redirect("/list");
    }
  );
});

app.get("/reject-product/:id", checkLogin, checkAdmin, (req, res) => {
  const id = req.params.id;

  db.run(
    `UPDATE products SET approveStatus='rejected' WHERE id=?`,
    [id],
    () => {
      res.redirect("/list");
    }
  );
});

app.get("/inbox", checkLogin, checkAdmin, (req, res) => {
  db.all(
    `SELECT * FROM weekly_reports ORDER BY createdAt DESC`,
    [],
    (err, rows) => {
      if (err) return res.send(err.message);

      res.send(`
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <title>管理员收件箱</title>
          <style>
            body{
              font-family: Arial, "Microsoft YaHei", sans-serif;
              margin:20px;
              background:#fff;
            }
            table{
              width:100%;
              border-collapse:collapse;
              margin-top:20px;
            }
            th, td{
              border:1px solid #ccc;
              padding:10px;
              text-align:center;
            }
            th{
              background:#f3f3f3;
            }
            a{
              color:#2f6fed;
              text-decoration:none;
            }
            .btn{
              display:inline-block;
              background:#2f6fed;
              color:#fff !important;
              text-decoration:none;
              padding:10px 16px;
              border-radius:4px;
              font-size:14px;
            }
          </style>
        </head>
        <body>
          <h2>管理员收件箱</h2>
          ${renderTopButtons(req.session.user)}

          <div style="margin: 12px 0;">
            <a href="/generate-weekly-pdf"
               class="btn"
               onclick="return confirm('确定立即生成一份新的汇总PDF吗？')">
              立即生成汇总PDF
            </a>
          </div>

          <table>
            <tr>
              <th>周开始</th>
              <th>周结束</th>
              <th>时间</th>
              <th>PDF</th>
            </tr>

            ${rows.map(r => `
              <tr>
                <td>${esc(r.weekStart || "")}</td>
                <td>${esc(r.weekEnd || "")}</td>
                <td>${esc(r.createdAt || "")}</td>
                <td><a href="/${esc(r.pdfPath || "")}" target="_blank">查看</a></td>
              </tr>
            `).join("")}
          </table>
        </body>
        </html>
      `);
    }
  );
});

app.get("/generate-weekly-pdf", checkLogin, checkAdmin, (req, res) => {
  generateWeeklySummaryPdf((err, pdfName) => {
    if (err) {
      return res.send("生成PDF失败：" + err.message);
    }
    res.redirect("/inbox");
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
  const changed = JSON.parse(row.changedFields||"[]");
function red(name){
  return changed.includes(name) ? "changed" : "";
}
  const isEdit = mode === "edit";
  const action = isEdit ? `/update/${row.id}` : "/save";
  const title = isEdit ? "Product Development Record Sheet - 编辑表单" : "Product Development Record Sheet - 新增表单";
  const buttonText = isEdit ? "保存修改" : "提交";

  const photoHtml = row.photoPath
    ? `<img src="/uploads/${esc(row.photoPath)}" style="max-width:100%;max-height:100%;object-fit:contain;">`
    : `<div class="photo-inner">ⓘ<span>暂无照片</span></div>`;

const deletePhotoLink = `<a href="javascript:void(0)" id="deletePhotoBtn" style="color:#d32f2f;text-decoration:none;">删除照片</a>`;

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
    .changed{
    border:2px solid red !important;
    color:red !important;
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
  background: #ffffff;
  padding: 4px 8px;
  font-size: 14px;
}

.textarea {
  height: 96px;
  resize: vertical;
  padding-top: 6px;
}

/* 手动填写保持白底 */
.calc {
  background: #ffffff !important;
}

/* 自动计算结果用浅蓝底 */
.readonly-red {
  border: 1px solid #ff6b6b;
  background: #eaf4ff !important;
  color: #222;
}

.readonly-gray {
  border: 1px solid #c8d9ee;
  background: #eaf4ff !important;
  color: #222;
}

.transport-spacer,
.p2-spacer {
  background: #efefef !important;
}

.p2-note {
  text-align: left;
  color: #666;
  font-size: 13px;
  padding-left: 12px;
  background: #efefef !important;
}
  .competitor-table .input {
  height: 32px;
}

.competitor-table th,
.competitor-table td {
  vertical-align: middle;
}

.competitor-table .label {
  width: 110px;
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
      .fee-layout .label{
  width:auto;
  min-width:140px;
}

.fee-layout td{
  height:42px;
}

.fee-layout .input{
  height:34px;
}

.fee-layout td:empty{
  background:#efefef;
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

   <form method="POST" action="${action}" enctype="multipart/form-data" id="productForm">
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

            <td class="label">产品名称*</td>
      <td><input class="input" type="text" name="productName" id="productName" value="${esc(row.productName || "")}" /></td>
<td class="label"></td>
<td></td>
<td></td>
          </tr>
          <tr>
            <td class="label">产品编号</td>
            <td><input class="input" type="text" name="productCode" id="productCode" value="${esc(row.productCode || "自动生成")}" /></td>
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
  <td><input class="input calc" type="number" step="0.001" name="adRate" id="adRate" value="${esc(row.adRate || "10")}" /></td>
</tr>
          <tr>
            <td class="label">分销减采购成本利润*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="profitCostDiff" id="profitCostDiff" value="${esc(row.profitCostDiff || "")}" readonly /></td>
            <td class="label">利润率1(%)*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="profitRate1" id="profitRate1" value="${esc(row.profitRate1 || "")}" readonly /></td>
          </tr>
          <tr>
            <td class="label">销售价(USD)*</td>
            <td><input class="input calc" type="number" step="0.001" name="sellingPriceUsd" id="sellingPriceUsd" value="${esc(row.sellingPriceUsd || "")}" /></td>
            <td class="label">销售价(RMB)*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="sellingPriceRmb" id="sellingPriceRmb" value="${esc(row.sellingPriceRmb || "")}" readonly /></td>
          </tr>
          <tr>
            <td class="label">销售价-分销价利润*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="profitSellDiff" id="profitSellDiff" value="${esc(row.profitSellDiff || "")}" readonly /></td>
            <td class="label">利润率2(%)*</td>
            <td><input class="input readonly-red" type="number" step="0.001" name="profitRate2" id="profitRate2" value="${esc(row.profitRate2 || "")}" readonly /></td>
          </tr>
          <tr>
  <td class="label">仓储费率</td>
  <td><input class="input calc" type="number" step="0.001" name="storageRateUsd" id="storageRateUsd" value="${esc(row.storageRateUsd || "0.78")}" /></td>
  </tr>

         <tr>
  <td class="label">备注</td>
  <td colspan="4"><textarea class="textarea" name="remark" id="remark">${esc(row.remark || "")}</textarea></td>
</tr>
        </table>
      </div>

      <div class="white-gap"></div>

<div class="section">
  <table class="layout">
    <colgroup>
      <col style="width: 90px;">
      <col style="width: 150px;">
      <col style="width: 220px;">
      <col style="width: 150px;">
      <col style="width: 220px;">
      <col style="width: 220px;">
      <col style="width: 220px;">
    </colgroup>

    <tr>
      <td rowspan="4" class="left-title">包装</td>
      <td class="label">包装方式*</td>
      <td><input class="input" type="text" name="packageType" id="packageType" value="${esc(row.packageType || "")}" /></td>
      <td></td>
      <th>长/CM</th>
      <th>宽/CM</th>
      <th>高/CM</th>
    </tr>

    <tr>
      <td class="label">体积重1(/6000)*</td>
      <td><input class="input readonly-red" type="number" step="0.001" name="volumeWeight6000" id="volumeWeight6000" value="${esc(row.volumeWeight6000 || "")}" /></td>
      <td class="money-tag">KG</td>
      <td><input class="input calc" type="number" step="0.001" name="lengthCm" id="lengthCm" value="${esc(row.lengthCm || "")}" /></td>
      <td><input class="input calc" type="number" step="0.001" name="widthCm" id="widthCm" value="${esc(row.widthCm || "")}" /></td>
      <td><input class="input calc" type="number" step="0.001" name="heightCm" id="heightCm" value="${esc(row.heightCm || "")}" /></td>
    </tr>

    <tr>
      <td class="label">体积重2(/5000)*</td>
      <td><input class="input readonly-red" type="number" step="0.001" name="volumeWeight5000" id="volumeWeight5000" value="${esc(row.volumeWeight5000 || "")}" /></td>
      <td class="money-tag">KG</td>
      <td class="label">产品尺寸</td>
      <td colspan="3">
        <input class="input" type="text" name="productSize" id="productSize" value="${esc(row.productSize || "")}" />
      </td>
    </tr>

    <tr>
      <td class="label">实重*</td>
      <td><input class="input" type="number" step="0.001" name="actualWeight" id="actualWeight" value="${esc(row.actualWeight || "")}" /></td>
      <td class="money-tag">KG</td>
      <td class="label">尺寸分段*</td>
      <td colspan="3">
        <input type="hidden" name="sizeTier" id="sizeTier" value="${esc(row.sizeTier || "")}" />
        <input class="input readonly-gray" type="text" id="sizeTierText" value="${esc(serverSizeTierLabel(row.sizeTier || ""))}" readonly />
      </td>
    </tr>
  </table>
</div>


      <div class="white-gap"></div>

      <div class="section">
<table class="layout">
  <colgroup>
    <col style="width: 90px;">
    <col style="width: 190px;">
    <col style="width: 150px;">
    <col style="width: 170px;">
    <col style="width: 150px;">
    <col style="width: 170px;">
    <col style="width: 150px;">
    <col style="width: 170px;">
  </colgroup>

  <tr>
    <td rowspan="4" class="left-title">运输方式</td>
    <th></th><th></th><th></th><th></th><th></th><th></th><th></th>
  </tr>
  <tr>
    <td class="label">快递费(RMB)</td>
    <td><input class="input readonly-red" type="number" step="0.001" name="expressFee" id="expressFee" value="${esc(row.expressFee || "")}" /></td>
    <td class="label">利润(RMB)</td>
    <td><input class="input readonly-red" type="number" step="0.001" name="expressProfit" id="expressProfit" value="${esc(row.expressProfit || "")}" /></td>
    <td class="label">利润率(%)*</td>
    <td><input class="input readonly-red" type="number" step="0.001" name="expressProfitRate" id="expressProfitRate" value="${esc(row.expressProfitRate || "")}" /></td>
    <td class="transport-spacer" colspan="1"></td>
  </tr>
  <tr>
    <td class="label">空运费(RMB)</td>
    <td><input class="input readonly-red" type="number" step="0.001" name="airFee" id="airFee" value="${esc(row.airFee || "")}" /></td>
    <td class="label">利润(RMB)</td>
    <td><input class="input readonly-red" type="number" step="0.001" name="airProfit" id="airProfit" value="${esc(row.airProfit || "")}" /></td>
    <td class="label">利润率(%)*</td>
    <td><input class="input readonly-red" type="number" step="0.001" name="airProfitRate" id="airProfitRate" value="${esc(row.airProfitRate || "")}" /></td>
    <td class="transport-spacer" colspan="1"></td>
  </tr>
  <tr>
    <td class="label">海运费(RMB)</td>
    <td><input class="input readonly-red" type="number" step="0.001" name="seaFee" id="seaFee" value="${esc(row.seaFee || "")}" /></td>
    <td class="label">利润(RMB)</td>
    <td><input class="input readonly-red" type="number" step="0.001" name="seaProfit" id="seaProfit" value="${esc(row.seaProfit || "")}" /></td>
    <td class="label">利润率(%)*</td>
    <td><input class="input readonly-red" type="number" step="0.001" name="seaProfitRate" id="seaProfitRate" value="${esc(row.seaProfitRate || "")}" /></td>
    <td class="transport-spacer" colspan="1"></td>
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
            <td><input class="input readonly-gray" type="number" step="0.001" name="expressTotalPrice" id="expressTotalPrice" value="${esc(row.expressTotalPrice || "")}" readonly /></td>
            <td></td>
          </tr>
          <tr>
            <td class="label">空运</td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="airWeightQty" id="airWeightQty" value="${esc(row.airWeightQty || "")}" readonly /></td>
            <td><input class="input calc" type="number" step="0.001" name="airUnitPrice" id="airUnitPrice" value="${esc(row.airUnitPrice || "")}" /></td>
            <td><input class="input calc" type="number" step="0.001" name="airTax" id="airTax" value="${esc(row.airTax || "")}" /></td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="airTotalPrice" id="airTotalPrice" value="${esc(row.airTotalPrice || "")}" readonly /></td>
            <td></td>
          </tr>
          <tr>
            <td class="label">海运</td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="seaWeightQty" id="seaWeightQty" value="${esc(row.seaWeightQty || "")}" readonly /></td>
            <td><input class="input calc" type="number" step="0.001" name="seaUnitPrice" id="seaUnitPrice" value="${esc(row.seaUnitPrice || "")}" /></td>
            <td><input class="input calc" type="number" step="0.001" name="seaTax" id="seaTax" value="${esc(row.seaTax || "")}" /></td>
            <td><input class="input readonly-gray" type="number" step="0.001" name="seaTotalPrice" id="seaTotalPrice" value="${esc(row.seaTotalPrice || "")}" readonly /></td>
            <td></td>
          </tr>
        </table>
      </div>

      <div class="white-gap"></div>
<div class="section">
  <table class="layout">
    <colgroup>
      <col style="width: 12.5%;">
      <col style="width: 12.5%;">
      <col style="width: 12.5%;">
      <col style="width: 12.5%;">
      <col style="width: 12.5%;">
      <col style="width: 12.5%;">
      <col style="width: 12.5%;">
      <col style="width: 12.5%;">
    </colgroup>

    <tr>
      <td class="label">FBA费用(RMB)</td>
      <td><input class="input readonly-gray" type="number" step="0.001" name="fbaFeeRmb" id="fbaFeeRmb" value="${esc(row.fbaFeeRmb || "")}" readonly /></td>

      <td class="label">佣金(RMB)</td>
      <td><input class="input readonly-gray" type="number" step="0.001" name="commissionRmb" id="commissionRmb" value="${esc(row.commissionRmb || "")}" readonly /></td>

      <td class="label">亚马逊退货成本(RMB)</td>
      <td><input class="input readonly-gray" type="number" step="0.001" name="amazonReturnCostRmb" id="amazonReturnCostRmb" value="${esc(row.amazonReturnCostRmb || "")}" readonly /></td>

      <td class="label">退货率(%)</td>
      <td><input class="input calc" type="number" step="0.001" name="returnRate" id="returnRate" value="${esc(row.returnRate || "")}" /></td>
    </tr>

    <tr>
     <td class="label">仓租(RMB)</td>
<td><input class="input readonly-gray" type="number" step="0.001" name="warehouseUsd" id="warehouseUsd" value="${esc(row.warehouseUsd || "")}" readonly /></td>

<td class="label">配送+分拨(RMB)</td>
<td><input class="input calc" type="number" step="0.001" name="deliveryUsd" id="deliveryUsd" value="${esc(row.deliveryUsd || "")}" /></td>
      
<td class="label">广告费(RMB)</td>
    <td><input class="input readonly-gray" type="number" step="0.001" name="adCostRmb" id="adCostRmb" value="${esc(row.adCostRmb || "")}" readonly /></td>

     <td class="label">退货成本(RMB)</td>
<td><input class="input readonly-gray" type="number" step="0.001" name="returnCostByRateRmb" id="returnCostByRateRmb" value="${esc(row.returnCostByRateRmb || "")}" readonly /></td>
    </tr>
  </table>
</div>

      <!-- 竞品区 START -->
<div class="section">
  <table class="layout competitor-table">
    <tr>
      <td colspan="4" class="title-bar">竞品信息</td>
    </tr>

    <tr>
      <th>竞品</th>
      <th>名称</th>
      <th>链接</th>
      <th>价格</th>
    </tr>

 <tr>
  <td class="label">竞品1</td>
  <td><input class="input" name="competitor1Name" id="competitor1Name" value="${esc(row.competitor1Name||"")}" /></td>
  <td><input class="input" name="competitor1Link" id="competitor1Link" value="${esc(row.competitor1Link||"")}" /></td>
  <td>
    <input class="input" name="competitor1Price" id="competitor1Price" value="${esc(row.competitor1Price||"")}" />
    <input type="hidden" name="competitor1Image" id="competitor1Image" value="${esc(row.competitor1Image||"")}" />
  </td>
</tr>

<tr>
  <td class="label">竞品2</td>
  <td><input class="input" name="competitor2Name" id="competitor2Name" value="${esc(row.competitor2Name||"")}" /></td>
  <td><input class="input" name="competitor2Link" id="competitor2Link" value="${esc(row.competitor2Link||"")}" /></td>
  <td>
    <input class="input" name="competitor2Price" id="competitor2Price" value="${esc(row.competitor2Price||"")}" />
    <input type="hidden" name="competitor2Image" id="competitor2Image" value="${esc(row.competitor2Image||"")}" />
  </td>
</tr>

    <tr>
      <td class="label">竞品3</td>
      <td><input class="input" name="competitor3Name" id="competitor3Name" value="${esc(row.competitor3Name||"")}" /></td>
      <td><input class="input" name="competitor3Link" id="competitor3Link" value="${esc(row.competitor3Link||"")}" /></td>
      <td>
        <input class="input" name="competitor3Price" id="competitor3Price" value="${esc(row.competitor3Price||"")}" />
        <input type="hidden" name="competitor3Image" id="competitor3Image" value="${esc(row.competitor3Image||"")}" />
      </td>
    </tr>

    <tr>
  <td class="label">竞品4</td>
  <td><input class="input" name="competitor4Name" id="competitor4Name" value="${esc(row.competitor4Name||"")}" /></td>
  <td><input class="input" name="competitor4Link" id="competitor4Link" value="${esc(row.competitor4Link||"")}" /></td>
  <td>
    <input class="input" name="competitor4Price" id="competitor4Price" value="${esc(row.competitor4Price||"")}" />
    <input type="hidden" name="competitor4Image" id="competitor4Image" value="${esc(row.competitor4Image||"")}" />
  </td>
</tr>

<tr>
  <td class="label">竞品5</td>
  <td><input class="input" name="competitor5Name" id="competitor5Name" value="${esc(row.competitor5Name||"")}" /></td>
  <td><input class="input" name="competitor5Link" id="competitor5Link" value="${esc(row.competitor5Link||"")}" /></td>
  <td>
    <input class="input" name="competitor5Price" id="competitor5Price" value="${esc(row.competitor5Price||"")}" />
    <input type="hidden" name="competitor5Image" id="competitor5Image" value="${esc(row.competitor5Image||"")}" />
  </td>
</tr>

<tr>
  <td class="label">自动生成</td>
  <td colspan="3">
    <button type="button" class="small-btn" onclick="autoFillCompetitors()">自动生成Amazon竞品链接</button>
  </td>
</tr>
  </table>
</div>
<!-- 竞品区 END -->

<div class="submit-wrap">
  <button type="submit" class="submit-btn">${buttonText}</button>
</div>

</form>

<script>
function $(id) {
  return document.getElementById(id);
}

function num(id) {
  const el = $(id);
  if (!el) return 0;
  const v = parseFloat(String(el.value || "").trim());
  return Number.isFinite(v) ? v : 0;
}

function setVal(id, val, digits = 3) {
  const el = $(id);
  if (!el) return;

  if (document.activeElement === el) return;
  if (el.dataset.manual === "1") return;

  const n = Number(val);
  if (val === "" || val === null || val === undefined || !Number.isFinite(n)) {
    el.value = "";
    return;
  }
  el.value = n.toFixed(digits);
}

function isManual(id) {
  const el = $(id);
  return !!(el && el.dataset.manual === "1" && String(el.value || "").trim() !== "");
}

function readOrCalc(id, calcValue, digits = 3) {
  if (isManual(id)) {
    return num(id);
  }
  setVal(id, calcValue, digits);
  return calcValue;
}

function cmToIn(cm) {
  return cm / 2.54;
}

function kgToLb(kg) {
  return kg * 2.2046226218;
}

function getSortedDimsIn(lengthCm, widthCm, heightCm) {
  const arr = [cmToIn(lengthCm), cmToIn(widthCm), cmToIn(heightCm)]
    .filter(n => Number.isFinite(n))
    .sort((a, b) => b - a);
  return {
    longest: arr[0] || 0,
    median: arr[1] || 0,
    shortest: arr[2] || 0
  };
}

function getLengthPlusGirth(longest, median, shortest) {
  return longest + 2 * (median + shortest);
}

function getPriceBand(sellingPriceUsd) {
  if (sellingPriceUsd < 10) return "lt10";
  if (sellingPriceUsd <= 50) return "10to50";
  return "gt50";
}

function pickPriceBandValue(band, lt10, mid, gt50) {
  if (band === "lt10") return lt10;
  if (band === "10to50") return mid;
  return gt50;
}

function sizeTierLabel(code) {
  const map = {
    small_standard: "小号标准尺寸",
    large_standard: "大号标准尺寸",
    small_bulky: "小号大件",
    large_bulky: "大号大件",
    oversize_0_50: "超大件 0-50磅",
    oversize_50_70: "超大件 50-70磅",
    oversize_70_150: "超大件 70-150磅",
    oversize_150_plus: "超大件 150磅以上"
  };
  return map[code] || "";
}

function detectSizeTier(lengthCm, widthCm, heightCm, actualWeightKg) {
  if (!(lengthCm > 0 && widthCm > 0 && heightCm > 0 && actualWeightKg > 0)) {
    return "";
  }

  const { longest, median, shortest } = getSortedDimsIn(lengthCm, widthCm, heightCm);
  const unitWeightLb = kgToLb(actualWeightKg);
  const lengthPlusGirth = getLengthPlusGirth(longest, median, shortest);

  if (
    unitWeightLb <= 1 &&
    longest <= 15 &&
    median <= 12 &&
    shortest <= 0.75
  ) {
    return "small_standard";
  }

  if (
    unitWeightLb <= 20 &&
    longest <= 18 &&
    median <= 14 &&
    shortest <= 8
  ) {
    return "large_standard";
  }

  if (
    unitWeightLb <= 50 &&
    longest <= 37 &&
    median <= 28 &&
    shortest <= 20 &&
    lengthPlusGirth <= 130
  ) {
    return "small_bulky";
  }

  if (
    unitWeightLb <= 50 &&
    longest <= 59 &&
    median <= 33 &&
    shortest <= 33 &&
    lengthPlusGirth <= 130
  ) {
    return "large_bulky";
  }

  if (unitWeightLb <= 50) return "oversize_0_50";
  if (unitWeightLb <= 70) return "oversize_50_70";
  if (unitWeightLb <= 150) return "oversize_70_150";
  return "oversize_150_plus";
}

function getAmazonShippingWeightLb(sizeTier, lengthCm, widthCm, heightCm, actualWeightKg) {
  if (!sizeTier) return 0;

  const unitWeightLb = kgToLb(actualWeightKg);
  const { longest, median, shortest } = getSortedDimsIn(lengthCm, widthCm, heightCm);

  // Amazon 规则：
  // small_standard、oversize_150_plus 直接用商品重量
  if (sizeTier === "small_standard" || sizeTier === "oversize_150_plus") {
    return unitWeightLb;
  }

  // large standard / small bulky / large bulky / extra-large:
  // 用 max(unit weight, dimensional weight)
  // 并且宽、高至少按 2 inch 算
  const dimWeightLb = (longest * Math.max(median, 2) * Math.max(shortest, 2)) / 139;

  return Math.max(unitWeightLb, dimWeightLb);
}

function ceilQuarter(x) {
  return Math.ceil((x * 4) - 1e-9) / 4;
}

function ceilPound(x) {
  return Math.ceil(x - 1e-9);
}

// 按你截图里的“自 2026 年 1 月 15 日起”非旺季费率
function getFbaFeeUsd2026(sizeTier, shippingWeightLb, sellingPriceUsd) {
  if (!sizeTier || shippingWeightLb <= 0) return 0;

  const band = getPriceBand(sellingPriceUsd);
  const oz = shippingWeightLb * 16;

  if (sizeTier === "small_standard") {
    if (oz <= 2)  return pickPriceBandValue(band, 2.43, 3.32, 3.58);
    if (oz <= 4)  return pickPriceBandValue(band, 2.49, 3.42, 3.68);
    if (oz <= 6)  return pickPriceBandValue(band, 2.56, 3.45, 3.71);
    if (oz <= 8)  return pickPriceBandValue(band, 2.66, 3.54, 3.80);
    if (oz <= 10) return pickPriceBandValue(band, 2.77, 3.68, 3.94);
    if (oz <= 12) return pickPriceBandValue(band, 2.82, 3.78, 4.04);
    if (oz <= 14) return pickPriceBandValue(band, 2.92, 3.91, 4.17);
    return pickPriceBandValue(band, 2.95, 3.96, 4.22); // 14-16 oz
  }

  if (sizeTier === "large_standard") {
    if (oz <= 4)  return pickPriceBandValue(band, 2.91, 3.73, 3.99);
    if (oz <= 8)  return pickPriceBandValue(band, 3.13, 3.95, 4.21);
    if (oz <= 12) return pickPriceBandValue(band, 3.38, 4.20, 4.46);
    if (oz <= 16) return pickPriceBandValue(band, 3.78, 4.60, 4.86);

    if (shippingWeightLb <= 1.25) return pickPriceBandValue(band, 4.22, 5.04, 5.30);
    if (shippingWeightLb <= 1.50) return pickPriceBandValue(band, 4.60, 5.42, 5.68);
    if (shippingWeightLb <= 1.75) return pickPriceBandValue(band, 4.75, 5.57, 5.83);
    if (shippingWeightLb <= 2.00) return pickPriceBandValue(band, 5.00, 5.82, 6.08);
    if (shippingWeightLb <= 2.25) return pickPriceBandValue(band, 5.10, 5.92, 6.18);
    if (shippingWeightLb <= 2.50) return pickPriceBandValue(band, 5.28, 6.10, 6.36);
    if (shippingWeightLb <= 2.75) return pickPriceBandValue(band, 5.44, 6.26, 6.52);
    if (shippingWeightLb <= 3.00) return pickPriceBandValue(band, 5.85, 6.67, 6.93);

    const base = pickPriceBandValue(band, 6.15, 6.97, 7.23);
    const extraQuarterLb = Math.ceil(((shippingWeightLb - 3) * 4) - 1e-9);
    return base + Math.max(0, extraQuarterLb) * 0.08;
  }

  if (sizeTier === "small_bulky") {
    const base = pickPriceBandValue(band, 6.78, 7.55, 7.55);
    const extraLb = Math.max(0, ceilPound(shippingWeightLb - 1));
    return base + extraLb * 0.38;
  }

  if (sizeTier === "large_bulky") {
    const base = pickPriceBandValue(band, 8.58, 9.35, 9.35);
    const extraLb = Math.max(0, ceilPound(shippingWeightLb - 1));
    return base + extraLb * 0.38;
  }

  if (sizeTier === "oversize_0_50") {
    const base = pickPriceBandValue(band, 25.56, 26.33, 26.33);
    const extraLb = Math.max(0, ceilPound(shippingWeightLb - 1));
    return base + extraLb * 0.38;
  }

  if (sizeTier === "oversize_50_70") {
    const base = pickPriceBandValue(band, 36.55, 37.32, 37.32);
    const extraLb = Math.max(0, ceilPound(shippingWeightLb - 51));
    return base + extraLb * 0.75;
  }

  if (sizeTier === "oversize_70_150") {
    const base = pickPriceBandValue(band, 50.55, 51.32, 51.32);
    const extraLb = Math.max(0, ceilPound(shippingWeightLb - 71));
    return base + extraLb * 0.75;
  }

  if (sizeTier === "oversize_150_plus") {
    const base = pickPriceBandValue(band, 194.18, 194.95, 194.95);
    const extraLb = Math.max(0, ceilPound(shippingWeightLb - 151));
    return base + extraLb * 0.19;
  }

  return 0;
}

function calcAll() {
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

  const volumeWeight6000 = readOrCalc("volumeWeight6000", lengthCm * widthCm * heightCm / 6000);
  const volumeWeight5000 = readOrCalc("volumeWeight5000", lengthCm * widthCm * heightCm / 5000);

  const detectedTier = detectSizeTier(lengthCm, widthCm, heightCm, actualWeight);

  if ($("sizeTier")) {
    $("sizeTier").value = detectedTier || "";
  }
  if ($("sizeTierText")) {
    $("sizeTierText").value = sizeTierLabel(detectedTier);
  }

  const sellingPriceRmb = readOrCalc("sellingPriceRmb", sellingPriceUsd * exchangeRate);
const profitCostDiff = readOrCalc("profitCostDiff", fenxiaoPrice - purchaseCost);
const profitRate1 = readOrCalc("profitRate1", purchaseCost ? (profitCostDiff / purchaseCost) * 100 : 0);
const profitSellDiff = readOrCalc("profitSellDiff", sellingPriceRmb - fenxiaoPrice);

// 改成：利润率2 = （销售价-分销价利润） / 销售价RMB
const profitRate2 = readOrCalc("profitRate2", sellingPriceRmb ? (profitSellDiff / sellingPriceRmb) * 100 : 0);

// 快递、空运 = 体积重2（5000）
// 海运 = 体积重1（6000）
const expressWeightQty = readOrCalc("expressWeightQty", volumeWeight5000);
const airWeightQty = readOrCalc("airWeightQty", volumeWeight5000);
const seaWeightQty = readOrCalc("seaWeightQty", volumeWeight6000);

const expressTotalPrice = readOrCalc("expressTotalPrice", expressWeightQty * expressUnitPrice * expressTax);
const airTotalPrice = readOrCalc("airTotalPrice", airWeightQty * airUnitPrice * airTax);
const seaTotalPrice = readOrCalc("seaTotalPrice", seaWeightQty * seaUnitPrice * seaTax);

// 佣金 = 销售价USD * 佣金% * 汇率
const commissionRmb = readOrCalc("commissionRmb", sellingPriceUsd * (commissionRate / 100) * exchangeRate);

// 广告费RMB = 销售价RMB * 广告费%
const adCostRmb = readOrCalc("adCostRmb", sellingPriceRmb * (adRate / 100));

// FBA费用
const shippingWeightLb = getAmazonShippingWeightLb(detectedTier, lengthCm, widthCm, heightCm, actualWeight);
const fbaFeeUsd = getFbaFeeUsd2026(detectedTier, shippingWeightLb, sellingPriceUsd);
const fbaFeeRmb = readOrCalc("fbaFeeRmb", fbaFeeUsd * exchangeRate);

// 仓租 = 体积(cubic feet) * 仓储费率
const cubicFeet =
  lengthCm > 0 && widthCm > 0 && heightCm > 0
    ? (lengthCm * widthCm * heightCm) / 28316.8466
    : 0;

const storageRateUsd = num("storageRateUsd") || 0.78;

// 仓租显示为 RMB：体积(cubic feet) * 仓储费率 * 实时汇率
const warehouseRmb = readOrCalc(
  "warehouseUsd",
  cubicFeet * storageRateUsd * exchangeRate
);

// 配送+分拨现在也按 RMB 手动录入
const deliveryRmb = num("deliveryUsd");

const returnRate = num("returnRate");

// 亚马逊退货成本 = 原公式结果 × 退货率(%)
const amazonReturnCostUsdBase = exchangeRate
  ? Math.min((commissionRmb / exchangeRate) * 0.2, 5)
  : 0;

const amazonReturnCostRmb = readOrCalc(
  "amazonReturnCostRmb",
  amazonReturnCostUsdBase * exchangeRate * (returnRate / 100)
);

// 退货成本 = 销售价RMB * 退货率
const returnCostByRateRmb = readOrCalc(
  "returnCostByRateRmb",
  sellingPriceRmb * (returnRate / 100)
);

// 总退货成本
const returnCostRmb = readOrCalc(
  "returnCostRmb",
  amazonReturnCostRmb + returnCostByRateRmb
);

// 运输方式右边显示下面的价格(RMB)
const expressFee = readOrCalc("expressFee", expressTotalPrice);
const airFee = readOrCalc("airFee", airTotalPrice);
const seaFee = readOrCalc("seaFee", seaTotalPrice);


// B = FBA费用 + 佣金 + 退货成本 + 仓租 + 配送+分拨 + 广告费
const B = fbaFeeRmb + commissionRmb + returnCostRmb + warehouseRmb + deliveryRmb + adCostRmb;

// A = 对应运输价格(RMB)
const expressA = expressFee;
const airA = airFee;
const seaA = seaFee;

// 利润 = 销售价RMB - 分销价RMB - A - B
const expressProfit = readOrCalc(
  "expressProfit",
  sellingPriceRmb - fenxiaoPrice - expressA - B
);

const airProfit = readOrCalc(
  "airProfit",
  sellingPriceRmb - fenxiaoPrice - airA - B
);

const seaProfit = readOrCalc(
  "seaProfit",
  sellingPriceRmb - fenxiaoPrice - seaA - B
);

// 利润率 = 利润 / 销售价RMB
readOrCalc("expressProfitRate", sellingPriceRmb ? (expressProfit / sellingPriceRmb) * 100 : 0);
readOrCalc("airProfitRate", sellingPriceRmb ? (airProfit / sellingPriceRmb) * 100 : 0);
readOrCalc("seaProfitRate", sellingPriceRmb ? (seaProfit / sellingPriceRmb) * 100 : 0);
}

function fetchRate() {
  const rateInput = $("exchangeRate");
  if (!rateInput) return;

  fetch("https://open.er-api.com/v6/latest/USD")
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      const rate = Number((data && data.rates && data.rates.CNY) || 0);
      if (!rate) {
        alert("汇率获取失败");
        return;
      }
      rateInput.value = rate.toFixed(4);
      calcAll();
    })
    .catch(function (err) {
      console.error("汇率接口失败：", err);
      alert("汇率获取失败");
    });
}

async function autoFillCompetitors() {
  const productNameEl = $("productName");
  const name = productNameEl ? productNameEl.value.trim() : "";

  if (!name) {
    alert("先输入产品名称");
    return;
  }

  const btn = document.querySelector('button[onclick="autoFillCompetitors()"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "生成中...";
  }

  try {
    const res = await fetch("/api/competitors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.detail || data.error || "竞品生成失败");
    }

    for (let i = 0; i < 5; i++) {
      const item = data[i] || {};
      if ($("competitor" + (i + 1) + "Name")) $("competitor" + (i + 1) + "Name").value = item.nameCn || item.cn || "";
      if ($("competitor" + (i + 1) + "Link")) $("competitor" + (i + 1) + "Link").value = item.link || "";
      if ($("competitor" + (i + 1) + "Image")) $("competitor" + (i + 1) + "Image").value = item.image || "";
      if ($("competitor" + (i + 1) + "Price")) $("competitor" + (i + 1) + "Price").value = item.price || "";
    }
  } catch (err) {
    console.error(err);
    alert(err.message || "竞品生成失败");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "自动生成Amazon竞品链接";
    }
  }
}

function bindCalc(id) {
  const el = $(id);
  if (!el) return;
  el.addEventListener("input", calcAll);
  el.addEventListener("change", calcAll);
}

function bindManualCalc(id) {
  const el = $(id);
  if (!el) return;

  function markManualAndRecalc() {
    this.dataset.manual = String(this.value || "").trim() === "" ? "0" : "1";
    calcAll();
  }

  el.addEventListener("input", markManualAndRecalc);
  el.addEventListener("change", markManualAndRecalc);

  el.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && this.tagName !== "TEXTAREA") {
      e.preventDefault();
      this.dataset.manual = String(this.value || "").trim() === "" ? "0" : "1";
      this.blur();
      calcAll();
    }
  });
}

function initPhotoPreview() {
  const photoInput = $("photoInput");
  const photoBox = $("photoPreviewBox");
  if (!photoInput || !photoBox) return;

  photoInput.addEventListener("change", function () {
    const file = this.files && this.files[0];

    if (!file) {
      photoBox.innerHTML = '<div class="photo-inner">ⓘ<span>暂无照片</span></div>';
      return;
    }

    const reader = new FileReader();
    reader.onload = function (ev) {
      photoBox.innerHTML = '<img src="' + ev.target.result + '" style="max-width:100%;max-height:100%;object-fit:contain;">';
    };
    reader.readAsDataURL(file);
  });
}

function initDeletePhoto() {
  const deleteBtn = $("deletePhotoBtn");
  if (!deleteBtn) return;

  deleteBtn.addEventListener("click", function () {
    const pathParts = window.location.pathname.split("/");
    const isEditPage =
      pathParts.length >= 3 &&
      pathParts[1] === "edit" &&
      pathParts[2] &&
      !isNaN(Number(pathParts[2]));

    if (isEditPage) {
      const editId = pathParts[2];
      if (confirm("确定删除这张照片吗？")) {
        window.location.href = "/delete-photo/" + editId;
      }
      return;
    }

    if ($("photoInput")) $("photoInput").value = "";
    if ($("photoPreviewBox")) {
      $("photoPreviewBox").innerHTML = '<div class="photo-inner">ⓘ<span>暂无照片</span></div>';
    }
  });
}

function initProductCode() {
  const codeInput = $("productCode");
  if (!codeInput) return;

  if (!codeInput.value || codeInput.value === "自动生成") {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const rand = Math.floor(Math.random() * 900 + 100);
    codeInput.value = "" + y + m + d + rand;
  }
}

function initPriceCache() {
  try {
    if ($("airUnitPrice") && !$("airUnitPrice").value) {
      $("airUnitPrice").value = localStorage.getItem("airUnitPrice") || "";
    }
    if ($("seaUnitPrice") && !$("seaUnitPrice").value) {
      $("seaUnitPrice").value = localStorage.getItem("seaUnitPrice") || "";
    }
  } catch (e) {
    console.error("读取本地缓存失败：", e);
  }
}

function savePriceCache() {
  try {
    ["airUnitPrice", "seaUnitPrice"].forEach(function (id) {
      const el = $(id);
      if (!el) return;
      el.addEventListener("change", function () {
        localStorage.setItem(id, this.value || "");
      });
    });
  } catch (e) {
    console.error("保存本地缓存失败：", e);
  }
}

window.addEventListener("DOMContentLoaded", function () {
  const form = $("productForm");
  if (form) {
    form.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        e.target.blur();
      }
    });
  }

  initPhotoPreview();
  initDeletePhoto();
  initProductCode();
  initPriceCache();

  if ($("expressTax") && !$("expressTax").value) $("expressTax").value = "1";
  if ($("airTax") && !$("airTax").value) $("airTax").value = "1";
  if ($("seaTax") && !$("seaTax").value) $("seaTax").value = "1";

[
  "exchangeRate",
  "purchaseCost",
  "commissionRate",
  "fenxiaoPrice",
  "adRate",
  "storageRateUsd",
  "deliveryUsd",
  "returnRate",
  "sellingPriceUsd",
  "lengthCm",
  "widthCm",
  "heightCm",
  "actualWeight",
  "expressUnitPrice",
  "airUnitPrice",
  "seaUnitPrice",
  "expressTax",
  "airTax",
  "seaTax"
].forEach(bindCalc);

[
  "volumeWeight6000",
  "volumeWeight5000",
  "sellingPriceRmb",
  "profitCostDiff",
  "profitRate1",
  "profitSellDiff",
  "profitRate2",
  "expressWeightQty",
  "airWeightQty",
  "seaWeightQty",
  "expressTotalPrice",
  "airTotalPrice",
  "seaTotalPrice",
  "commissionRmb",
  "adCostRmb",
  "warehouseUsd",
  "fbaFeeRmb",
  "amazonReturnCostRmb",
  "returnCostByRateRmb",
  "returnCostRmb",
  "expressFee",
  "airFee",
  "seaFee",
  "expressProfit",
  "airProfit",
  "seaProfit",
  "expressProfitRate",
  "airProfitRate",
  "seaProfitRate"
].forEach(bindManualCalc);

  savePriceCache();
  calcAll();

  if ($("exchangeRate") && !$("exchangeRate").value) {
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
  const username = req.body.username;
  const password = req.body.password;

  db.get(
    "SELECT * FROM users WHERE username = ?",
    [username],
    (err, user) => {
      if (err || !user) {
        return res.send(renderLoginPage("用户名或密码错误"));
      }

if (user.approval_status !== "approved") {
  return res.send(renderLoginPage("该账户尚未通过管理员审核"));
}

      if (user.password_hash !== hashPassword(password)) {
        return res.send(renderLoginPage("用户名或密码错误"));
      }

      // 🚨 审核判断
      if (user.approval_status !== "approved") {
        return res.send(renderLoginPage("账号未通过管理员审核"));
      }

      req.session.user = user;

      db.run(
        "UPDATE users SET last_login_at = datetime('now','localtime') WHERE id=?",
        [user.id]
      );

      res.redirect("/list");
    }
  );
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

  if (username.length < 3 || password.length < 6) {
    return res.send(renderRegisterPage("用户名至少3位，密码至少6位"));
  }

  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.send(renderRegisterPage("用户名只能包含字母数字"));
  }

 db.run(
  `INSERT INTO users (username, password_hash, password_plain, is_admin, approval_status)
   VALUES (?, ?, ?, 0, 'pending')`,
  [username, hashPassword(password), password],
  function (err) {
    if (err) {
      return res.send(renderRegisterPage("注册失败，用户名可能已存在"));
    }
    return res.send(renderLoginPage("注册申请已提交，请等待管理员审核通过后登录"));
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
  volumeWeight6000, volumeWeight5000, actualWeight, lengthCm, widthCm, heightCm, productSize, sizeTier,
  expressFee, expressProfit, expressProfitRate,
  airFee, airProfit, airProfitRate,
  seaFee, seaProfit, seaProfitRate,
  expressWeightQty, expressUnitPrice, expressTax, expressTotalPrice,
  airWeightQty, airUnitPrice, airTax, airTotalPrice,
  seaWeightQty, seaUnitPrice, seaTax, seaTotalPrice,
  fbaFeeRmb, commissionRmb, returnCostRmb, returnRate, warehouseUsd, deliveryUsd, adCostRmb,
  storageRateUsd, amazonReturnCostRmb, returnCostByRateRmb,
  competitor1Name, competitor1Link, competitor1Image, competitor1Price,
  competitor2Name, competitor2Link, competitor2Image, competitor2Price,
  competitor3Name, competitor3Link, competitor3Image, competitor3Price,
  competitor4Name, competitor4Link, competitor4Image, competitor4Price,
  competitor5Name, competitor5Link, competitor5Image, competitor5Price,
  changedFields,
  photoPath, ownerUserId, ownerUsername, lastEditedByUserId, lastEditedByUsername,
  createdAt, updatedAt
) VALUES (
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?,
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
  d.productSize || "",
  d.sizeTier || "",
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
  d.returnRate || "",
  d.warehouseUsd || "",
  d.deliveryUsd || "",
  d.adCostRmb || "",
  d.storageRateUsd || "0.78",
  d.amazonReturnCostRmb || "",
  d.returnCostByRateRmb || "",
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
  d.competitor4Name || "",
  d.competitor4Link || "",
  d.competitor4Image || "",
  d.competitor4Price || "",
  d.competitor5Name || "",
  d.competitor5Link || "",
  d.competitor5Image || "",
  d.competitor5Price || "",
  "[]",
  photoPath,
  u.id,
  u.username,
  u.id,
  u.username
];

    console.log("save placeholders =", (sql.match(/\?/g) || []).length);
console.log("save values =", values.length);
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
    <th>产品图片</th>
    <th>表单名称</th>
    <th>产品名称</th>
    <th>产品编号</th>
    <th>利润率</th>
    <th>是否通过</th>
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
          <td>
            ${
              row.photoPath
                ? `<a href="/detail/${row.id}">
                     <img src="/uploads/${esc(row.photoPath)}" style="width:60px;height:60px;object-fit:cover;border-radius:4px;">
                   </a>`
                : `<a href="/detail/${row.id}" style="color:#999;text-decoration:none;">无图片</a>`
            }
          </td>
          <td><a href="/detail/${row.id}">${esc(row.formName || "")}</a></td>
          <td>${esc(row.productName || "")}</td>
          <td>${esc(row.productCode || "")}</td>
          <td>${esc(row.seaProfitRate || "")}%</td>
          <td>
            ${
              row.approveStatus === "approved"
                ? "✅ 通过"
                : row.approveStatus === "rejected"
                ? "❌ 不通过"
                : "⏳ 待审核"
            }
          </td>
          <td>${esc(row.purchaseCost || "")}</td>
          <td>${esc(row.sellingPriceUsd || "")}</td>
          ${user.is_admin ? `<td>${esc(row.ownerUsername || "")}</td><td>${esc(row.lastEditedByUsername || "")}</td>` : ""}
          <td>${esc(formatTime(row.updatedAt))}</td>
          <td>
            <a href="/edit/${row.id}">编辑</a>
            &nbsp;|&nbsp;
            <a href="/delete/${row.id}" onclick="return confirm('确定删除吗？')">删除</a>
            ${
              user.is_admin
                ? `&nbsp;|&nbsp;<a href="/approve-product/${row.id}">通过</a>
                   &nbsp;|&nbsp;<a href="/reject-product/${row.id}">不通过</a>`
                : ""
            }
          </td>
        </tr>
      `).join("")
      : `<tr><td colspan="${user.is_admin ? 11 : 9}" style="text-align:center;">暂无记录</td></tr>`
  }
</table>

        <script>
          function toggleDateRange() {
            const mode = document.getElementById("dateMode").value;
            document.getElementById("dateRangeBox").style.display =
              mode === "range" ? "inline-block" : "none";
          }
        </script>

<script>
function $(id) {
  return document.getElementById(id);
}

function num(id) {
  const el = document.getElementById(id);
  if (!el) return 0;
  const v = parseFloat(el.value);
  return isNaN(v) ? 0 : v;
}

function setVal(id, val, digits = 3) {
  const el = document.getElementById(id);
  if (!el) return;

  if (document.activeElement === el) return;
  if (el.dataset.manual === "1") return;

  if (val === "" || val === null || val === undefined || isNaN(val)) {
    el.value = "";
  } else {
    el.value = Number(val).toFixed(digits);
  }
}

function isManual(id) {
  const el = document.getElementById(id);
  return !!(el && el.dataset.manual === "1" && String(el.value || "").trim() !== "");
}

function readOrCalc(id, calcValue, digits = 3) {
  if (isManual(id)) {
    return num(id);
  }
  setVal(id, calcValue, digits);
  return calcValue;
}

function bindManualCalc(id) {
  const el = $(id);
  if (!el) return;

  function markManualAndRecalc() {
    this.dataset.manual = String(this.value || "").trim() === "" ? "0" : "1";
    calcAll();
  }

  el.addEventListener("input", markManualAndRecalc);
  el.addEventListener("change", markManualAndRecalc);

  el.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && this.tagName !== "TEXTAREA") {
      e.preventDefault();
      this.dataset.manual = String(this.value || "").trim() === "" ? "0" : "1";
      this.blur();
      calcAll();
    }
  });
}

function calcAll() {
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

  const volumeWeight1 = lengthCm * widthCm * heightCm / 6000;
const volumeWeight2 = lengthCm * widthCm * heightCm / 5000;

setVal("volumeWeight6000", volumeWeight1);
setVal("volumeWeight5000", volumeWeight2);

const sellingPriceRmb = sellingPriceUsd * exchangeRate;
const profitCostDiff = fenxiaoPrice - purchaseCost;
const profitRate1 = purchaseCost ? (profitCostDiff / purchaseCost) * 100 : 0;
const profitSellDiff = sellingPriceRmb - fenxiaoPrice;
const profitRate2 = sellingPriceRmb ? (profitSellDiff / sellingPriceRmb) * 100 : 0;

setVal("sellingPriceRmb", sellingPriceRmb);
setVal("profitCostDiff", profitCostDiff);
setVal("profitRate1", profitRate1);
setVal("profitSellDiff", profitSellDiff);
setVal("profitRate2", profitRate2);

const expressWeightQty = volumeWeight2;
const airWeightQty = volumeWeight2;
const seaWeightQty = volumeWeight1;

setVal("expressWeightQty", expressWeightQty);
setVal("airWeightQty", airWeightQty);
setVal("seaWeightQty", seaWeightQty);

const expressTotalPrice = expressWeightQty * expressUnitPrice * expressTax;
const airTotalPrice = airWeightQty * airUnitPrice * airTax;
const seaTotalPrice = seaWeightQty * seaUnitPrice * seaTax;

setVal("expressTotalPrice", expressTotalPrice);
setVal("airTotalPrice", airTotalPrice);
setVal("seaTotalPrice", seaTotalPrice);

const commissionRmb = sellingPriceRmb * (commissionRate / 100);
setVal("commissionRmb", commissionRmb);

// 广告费：优先用手动输入；如果没填，就按百分比自动算
const adCostRmb = sellingPriceRmb * (adRate / 100);
setVal("adCostRmb", adCostRmb);

// 仓租 / 配送+分拨：页面输入
const cubicFeet =
  lengthCm > 0 && widthCm > 0 && heightCm > 0
    ? (lengthCm * widthCm * heightCm) / 28316.8466
    : 0;

const storageRateUsd = Number($("storageRateUsd")?.value || 0.78);
const warehouseUsd = cubicFeet * storageRateUsd;
setVal("warehouseUsd", warehouseUsd);

const deliveryUsd = Number($("deliveryUsd")?.value || 0);

// FBA费用：手动输入
const shippingWeightLb = getAmazonShippingWeightLb(detectedTier, lengthCm, widthCm, heightCm, actualWeight);
const fbaFeeUsd = getFbaFeeUsd2026(detectedTier, shippingWeightLb, sellingPriceUsd);
const fbaFeeRmb = readOrCalc("fbaFeeRmb", fbaFeeUsd * exchangeRate);

const returnRate = Number($("returnRate")?.value || 0);

// 亚马逊退货成本 = 佣金 * 20%，最高 5 USD
const amazonReturnCostUsd = Math.min((commissionRmb / exchangeRate) * 0.2, 5);
const amazonReturnCostRmb = amazonReturnCostUsd * exchangeRate;
setVal("amazonReturnCostRmb", amazonReturnCostRmb);

// 退货率成本 = 销售价RMB * 退货率
const returnCostByRateRmb = sellingPriceRmb * (returnRate / 100);
setVal("returnCostByRateRmb", returnCostByRateRmb);

// 总退货成本
const returnCostRmb = amazonReturnCostRmb + returnCostByRateRmb;
setVal("returnCostRmb", returnCostRmb);

// 运费(RMB)
const expressFee = expressTotalPrice;
const airFee = airTotalPrice;
const seaFee = seaTotalPrice;

setVal("expressFee", expressFee);
setVal("airFee", airFee);
setVal("seaFee", seaFee);

// USD 转 RMB
const warehouseRmb = warehouseUsd * exchangeRate;
const deliveryRmb = deliveryUsd * exchangeRate;

// 利润 = （销售价 - 分销价利润）- 运费 - FBA - 佣金 - 退货成本 - 仓租 - 配送+分拨 - 广告费
const profitBase = profitSellDiff;

const expressProfit =
  profitBase
  - expressFee
  - fbaFeeRmb
  - commissionRmb
  - returnCostRmb
  - warehouseRmb
  - deliveryRmb
  - adCostRmb;

const airProfit =
  profitBase
  - airFee
  - fbaFeeRmb
  - commissionRmb
  - returnCostRmb
  - warehouseRmb
  - deliveryRmb
  - adCostRmb;

const seaProfit =
  profitBase
  - seaFee
  - fbaFeeRmb
  - commissionRmb
  - returnCostRmb
  - warehouseRmb
  - deliveryRmb
  - adCostRmb;

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

    if (row.productCode) {
      return res.send(renderFormPage({ mode: "edit", user: req.session.user, row }));
    }

    generateProductCode((codeErr, autoCode) => {
      if (codeErr) {
        return res.send("生成产品编号失败：" + codeErr.message);
      }

      row.productCode = autoCode;

      db.run(
        "UPDATE products SET productCode = ?, updatedAt = datetime('now','localtime') WHERE id = ?",
        [autoCode, req.params.id],
        () => {
          res.send(renderFormPage({ mode: "edit", user: req.session.user, row }));
        }
      );
    });
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

    const changedFields = [];
for(let k in d){
  if(String(d[k]) !== String(oldRow[k]||"")){
    changedFields.push(k);
  }
}

  const sql = `
  UPDATE products SET
    formName = ?, productName = ?, productCode = ?, exchangeRate = ?, purchaseCost = ?, commissionRate = ?,
    fenxiaoPrice = ?, adRate = ?, profitCostDiff = ?, profitRate1 = ?,
    sellingPriceUsd = ?, sellingPriceRmb = ?, profitSellDiff = ?, profitRate2 = ?,
    remark = ?, packageType = ?,
    volumeWeight6000 = ?, volumeWeight5000 = ?, actualWeight = ?, lengthCm = ?, widthCm = ?, heightCm = ?, productSize = ?, sizeTier = ?,
    expressFee = ?, expressProfit = ?, expressProfitRate = ?,
    airFee = ?, airProfit = ?, airProfitRate = ?,
    seaFee = ?, seaProfit = ?, seaProfitRate = ?,
    expressWeightQty = ?, expressUnitPrice = ?, expressTax = ?, expressTotalPrice = ?,
    airWeightQty = ?, airUnitPrice = ?, airTax = ?, airTotalPrice = ?,
    seaWeightQty = ?, seaUnitPrice = ?, seaTax = ?, seaTotalPrice = ?,
    fbaFeeRmb = ?, commissionRmb = ?, returnCostRmb = ?, returnRate = ?, warehouseUsd = ?, deliveryUsd = ?, adCostRmb = ?,
    storageRateUsd = ?, amazonReturnCostRmb = ?, returnCostByRateRmb = ?,
    competitor1Name = ?, competitor1Link = ?, competitor1Image = ?, competitor1Price = ?,
    competitor2Name = ?, competitor2Link = ?, competitor2Image = ?, competitor2Price = ?,
    competitor3Name = ?, competitor3Link = ?, competitor3Image = ?, competitor3Price = ?,
    competitor4Name = ?, competitor4Link = ?, competitor4Image = ?, competitor4Price = ?,
    competitor5Name = ?, competitor5Link = ?, competitor5Image = ?, competitor5Price = ?,
    changedFields = ?,
    photoPath = ?, lastEditedByUserId = ?, lastEditedByUsername = ?, updatedAt = datetime('now','localtime')
  WHERE id = ?
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
d.productSize || "",
d.sizeTier || "",
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
  d.returnRate || "",
  d.warehouseUsd || "",
  d.deliveryUsd || "",
  d.adCostRmb || "",
  d.storageRateUsd || "0.78",
  d.amazonReturnCostRmb || "",
  d.returnCostByRateRmb || "",
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
  d.competitor4Name || "",
  d.competitor4Link || "",
  d.competitor4Image || "",
  d.competitor4Price || "",
  d.competitor5Name || "",
  d.competitor5Link || "",
  d.competitor5Image || "",
  d.competitor5Price || "",
  JSON.stringify(changedFields || []),
  newPhotoPath,
  user.id,
  user.username,
  id
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

app.get("/approve-user/:id", checkAdmin, (req, res) => {
  const id = req.params.id;

  db.run(
    `UPDATE users 
     SET approval_status='approved',
         approved_by=?,
         approved_at=datetime('now','localtime')
     WHERE id=?`,
    [req.session.user.username, id],
    () => res.redirect("/users")
  );
});

app.get("/reject-user/:id", checkAdmin, (req, res) => {
  const id = req.params.id;

  db.run(
    `UPDATE users 
     SET approval_status='rejected'
     WHERE id=?`,
    [id],
    () => res.redirect("/users")
  );
});


  
app.get("/users", checkLogin, checkAdmin, (_req, res) => {
  db.all(
    "SELECT id, username, password_plain, is_admin, approval_status, created_at, last_login_at, last_edit_at FROM users ORDER BY id ASC",
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
            th, td { border:1px solid #ccc; padding:10px; text-align:left; }
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
              <th>是否通过申请注册</th>
              <th>最后登录时间</th>
              <th>最后编辑时间</th>
              <th>操作</th>
            </tr>
            ${rows.map(row => `
              <tr>
                <td>${row.id}</td>
                <td>
                  ${
                    row.is_admin
                      ? esc(row.username)
                      : `<a href="/user-products/${row.id}" style="color:#2f6fed;font-weight:bold;text-decoration:none;">${esc(row.username)}</a>`
                  }
                </td>
                <td>${esc(row.password_plain || "")}</td>
                <td>${row.is_admin ? "管理员" : "普通用户"}</td>
                <td>
                  ${
                    row.approval_status === "approved"
                      ? "✅ 通过"
                      : row.approval_status === "rejected"
                      ? "❌ 不通过"
                      : "⏳ 待审核"
                  }
                </td>
                <td>${esc(formatTimeCN(row.last_login_at))}</td>
                <td>${esc(formatTimeCN(row.last_edit_at))}</td>
                <td>
                  ${
                    row.is_admin
                      ? ""
                      : row.approval_status === "pending"
                      ? `
                        <a href="/approve-user/${row.id}">✅ 通过</a>
                        &nbsp;|&nbsp;
                        <a href="/reject-user/${row.id}">❌ 不通过</a>
                        &nbsp;|&nbsp;
                        <a href="/delete-user/${row.id}" onclick="return confirm('确定删除该用户吗？')">删除</a>
                      `
                      : `
                        <a href="/delete-user/${row.id}" onclick="return confirm('确定删除该用户吗？')">删除</a>
                      `
                  }
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

app.use(express.json());

async function translateToEnglish(text) {
  const apiKey = "AIzaSyBgtvuBIWkyIdni-jQTZYfE0qdyLXKhUcs";
  if (!apiKey) return text;

  try {
    const url = "https://translation.googleapis.com/language/translate/v2";

    const resp = await axios.post(url, null, {
      params: {
        key: apiKey,
        q: text,
        target: "en",
        format: "text"
      }
    });

    const translated =
      resp.data &&
      resp.data.data &&
      resp.data.data.translations &&
      resp.data.data.translations[0] &&
      resp.data.data.translations[0].translatedText;

    return translated || text;
  } catch (e) {
    console.error("Google 翻译失败：", e.response?.data || e.message);
    return text;
  }
}

async function translateToChinese(text) {
  const apiKey = "AIzaSyBgtvuBIWkyIdni-jQTZYfE0qdyLXKhUcs";
  if (!apiKey) return text;

  try {
    const url = "https://translation.googleapis.com/language/translate/v2";

    const resp = await axios.post(url, null, {
      params: {
        key: apiKey,
        q: text,
        target: "zh-CN",
        format: "text"
      }
    });

    const translated =
      resp.data &&
      resp.data.data &&
      resp.data.data.translations &&
      resp.data.data.translations[0] &&
      resp.data.data.translations[0].translatedText;

    return translated || text;
  } catch (e) {
    console.error("Google 中文翻译失败：", e.response?.data || e.message);
    return text;
  }
}



app.post("/api/competitors", async (req, res) => {
  const rawName = String(req.body.name || "").trim();
  if (!rawName) {
    return res.status(400).json({ error: "产品名称不能为空" });
  }

  try {
    const englishKeyword = await translateToEnglish(rawName);
    console.log("原始产品名：", rawName);
    console.log("翻译后关键词：", englishKeyword);

    const serpKey = "551d2bdc10516bb1a5f14482cdeb0faf9b0929de0a97f46a6f9b3b917c81050d";
    console.log("SERPAPI_KEY存在吗：", !!serpKey);
    if (!serpKey) {
      return res.status(500).json({ error: "缺少 SERPAPI_KEY" });
    }

    const serpResp = await axios.get("https://serpapi.com/search", {
      params: {
        engine: "amazon",
        amazon_domain: "amazon.com",
        k: englishKeyword,
        api_key: serpKey
      }
    });

    const organic = Array.isArray(serpResp.data.organic_results)
      ? serpResp.data.organic_results
      : [];

    const top5 = await Promise.all(
      organic.slice(0, 5).map(async (item, idx) => {
        const title = item.title || (rawName + " 竞品" + (idx + 1));
        const titleCn = await translateToChinese(title);
        const link = item.link || "";
        const image = item.thumbnail || item.image || "";
        const price =
          item.price && typeof item.price === "object"
            ? (item.price.value || item.price.raw || "")
            : (item.price || "");

        return {
          nameCn: titleCn || title,
          link,
          image,
          price: String(price || "")
        };
      })
    );

    while (top5.length < 5) {
      top5.push({
        nameCn: rawName + " 竞品" + (top5.length + 1),
        link: "",
        image: "",
        price: ""
      });
    }

    res.json(top5);
  } catch (e) {
    console.error("竞品生成失败：", e.response?.data || e.message);
    res.status(500).json({
      error: e.response?.data?.error || e.response?.data?.message || e.message || "竞品生成失败",
      detail: JSON.stringify(e.response?.data || e.message || "")
    });
  }
});

cron.schedule("0 18 * * 6", () => {
  console.log("开始生成周报...");
  generateWeeklySummaryPdf();
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("服务器已启动：" + PORT);
});
