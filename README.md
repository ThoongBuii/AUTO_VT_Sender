# WhatsApp QR Sender

Ung dung gui thong tin tu dong qua WhatsApp Web QR automation.

## Chay ung dung

```bash
npm install
npm start
```

Mo trinh duyet tai:

```text
http://localhost:3000
```

Nguoi dung co the bam **Dang ky** tren man hinh dau tien de tao tai khoan sales rieng.

Neu chua co `users.json`, app van tu tao admin mac dinh de quan tri:

```text
Tai khoan: admin
Mat khau: admin123
```

Hay doi/khong dung mat khau admin mac dinh khi deploy that.

## Cach su dung

1. Bam **Dang ky** de tao tai khoan sales, hoac **Dang nhap** neu da co tai khoan.
2. Mo WhatsApp tren dien thoai cua sales do.
3. Vao **Thiet bi lien ket**.
4. Quet ma QR hien tren giao dien web.
5. Bam **Tai danh ba/chat** de chon nguoi nhan theo ten hoac so dien thoai.
6. Hoac nhap danh sach so dien thoai thu cong, moi dong mot so.
7. Nhap noi dung, chon file neu can.
8. Bam **Gui tin nhan**.

Neu da bam **Dang xuat session**, ung dung se tu tao lai QR moi. Neu QR chua hien, bam
**Tao QR moi / dang nhap lai**.

## Ca nhan hoa noi dung

Co the chen bien vao noi dung tin nhan:

- `{name}`: ten day du lay tu chat/contact WhatsApp neu co.
- `{firstName}`: tu dau tien trong ten.
- `{phone}`: so dien thoai nguoi nhan.

Vi du:

```text
Hi {firstName}, minh gui ban thong tin nay.
```

## Trien khai online

Khong nen dua backend WhatsApp Web nay len Vercel Serverless vi ung dung can:

- Trinh duyet Chromium/Puppeteer chay lien tuc.
- Session dang nhap WhatsApp luu on dinh tren disk.
- Socket realtime va tien trinh gui co the chay lau hon timeout serverless.

Huong phu hop hon:

- VPS rieng, chay bang `pm2` hoac Docker.
- Render/Railway/Fly.io voi Docker va persistent disk neu can luu session.
- Vercel chi dung cho frontend tinh, backend WhatsApp chay o server rieng.

### Public mien phi tren Render

Project da co san `Dockerfile` va `render.yaml` de Render chay Chromium cho WhatsApp Web.

1. Day code len GitHub.
2. Vao Render, chon **New +** -> **Blueprint** neu muon dung `render.yaml`, hoac **Web Service**.
3. Chon repo cua project.
4. Neu tao Web Service thu cong, chon:

```text
Runtime: Docker
Plan: Free
```

5. Render se tu dung Dockerfile va tao URL dang:

```text
https://whatsapp-sender.onrender.com
```

6. Mo URL, bam **Dang ky**, tao tai khoan sales va quet QR WhatsApp.

Luu y voi Render Free:

- Service co the sleep/restart khi khong co truy cap.
- QR session `.wwebjs_auth/` co the mat neu Render free container bi tao lai.
- Neu can giu session lau dai, hay dung persistent disk/paid plan hoac VPS.

### Public tren VPS

1. Copy project len VPS.
2. Cai Node.js 20+ va Chrome/Chromium dependencies neu VPS chua co.
3. Tao file `.env` tu `.env.example` va dat `SESSION_SECRET` that dai.
4. Tao tai khoan cho tung sales:

```bash
npm run create-user -- sales01 "mat-khau-manh" "Sales 01"
npm run create-user -- sales02 "mat-khau-manh-khac" "Sales 02"
```

5. Chay bang PM2:

```bash
npm install -g pm2
pm2 start server.js --name whatsapp-sender
pm2 save
pm2 startup
```

6. Dat Nginx reverse proxy va HTTPS toi port `3000`.

Moi sales se co session web rieng va session WhatsApp rieng trong `.wwebjs_auth/`.

## Luu y

- Day la automation qua WhatsApp Web, khong phai API chinh thuc cua Meta.
- Chi gui toi nguoi da dong y nhan thong tin.
- Nen de delay toi thieu 20 giay moi tin de giam rui ro tai khoan bi han che.
- Session dang nhap WhatsApp duoc luu rieng theo tung sales trong `.wwebjs_auth/`.
- Lich su gui duoc ghi theo tung sales trong `logs/`.
