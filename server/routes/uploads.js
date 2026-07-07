const { Router } = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')

const router = Router()

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname)
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9가-힣_-]/g, '_')
    cb(null, `${Date.now()}_${base}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.xlsx', '.xls', '.docx', '.hwp']
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, allowed.includes(ext))
  },
})

router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없거나 허용되지 않는 형식입니다' })
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8')
  res.json({
    url:          `/uploads/${req.file.filename}`,
    originalName,
    size:         req.file.size,
    mimetype:     req.file.mimetype,
  })
})

module.exports = router
