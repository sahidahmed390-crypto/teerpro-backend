// TeerPro Backend Server - Complete Production System
// Features: Auth, Result Fetching, WebSocket, Win Detection

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/teerpro', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// ==================== DATABASE SCHEMAS ====================

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  settings: {
    notifications: { type: Boolean, default: true },
    language: { type: String, default: 'en' }
  },
  stats: {
    totalBets: { type: Number, default: 0 },
    wonBets: { type: Number, default: 0 },
    totalInvested: { type: Number, default: 0 },
    totalWon: { type: Number, default: 0 }
  }
});

const BetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  game: { type: String, required: true, enum: ['shillong', 'khanapara', 'juwai', 'night'] },
  round: { type: String, required: true, enum: ['FR', 'SR'] },
  number: { type: String, required: true },
  amount: { type: Number, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  status: { type: String, default: 'active', enum: ['active', 'won', 'lost'] },
  winAmount: { type: Number, default: 0 },
  resultNumber: String,
  createdAt: { type: Date, default: Date.now }
});

const ResultSchema = new mongoose.Schema({
  game: { type: String, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  fr: String,
  sr: String,
  frTime: String,
  srTime: String,
  declaredAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Bet = mongoose.model('Bet', BetSchema);
const Result = mongoose.model('Result', ResultSchema);

// ==================== AUTHENTICATION MIDDLEWARE ====================

const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ==================== AUTH ROUTES ====================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body;

    // Validate Meghalaya phone number (optional: add stricter validation)
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    // Check if user exists
    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return res.status(400).json({ error: 'Phone number already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = new User({
      name,
      phone,
      password: hashedPassword
    });

    await user.save();

    // Generate token
    const token = jwt.sign(
      { id: user._id, phone: user.phone },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        stats: user.stats
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user._id, phone: user.phone },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        stats: user.stats
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== BET ROUTES ====================

app.post('/api/bets', authenticateToken, async (req, res) => {
  try {
    const { game, round, number, amount, date } = req.body;

    // Validate bet
    if (amount < 5) {
      return res.status(400).json({ error: 'Minimum bet is ₹5' });
    }

    const bet = new Bet({
      userId: req.user.id,
      game,
      round,
      number: number.toString().padStart(2, '0'),
      amount,
      date
    });

    await bet.save();

    // Update user stats
    await User.findByIdAndUpdate(req.user.id, {
      $inc: {
        'stats.totalBets': 1,
        'stats.totalInvested': amount
      }
    });

    res.json(bet);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bets', authenticateToken, async (req, res) => {
  try {
    const { status, game, startDate, endDate } = req.query;
    
    const query = { userId: req.user.id };
    if (status) query.status = status;
    if (game) query.game = game;
    if (startDate && endDate) {
      query.date = { $gte: startDate, $lte: endDate };
    }

    const bets = await Bet.find(query).sort({ createdAt: -1 });
    res.json(bets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bets/stats', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user.stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== RESULT ROUTES ====================

app.get('/api/results/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const results = await Result.find({ date: today });
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/results/history', async (req, res) => {
  try {
    const { game, startDate, endDate, limit = 30 } = req.query;
    
    const query = {};
    if (game) query.game = game;
    if (startDate && endDate) {
      query.date = { $gte: startDate, $lte: endDate };
    }

    const results = await Result.find(query)
      .sort({ date: -1 })
      .limit(parseInt(limit));
    
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== RESULT FETCHING SYSTEM ====================

const RESULT_SOURCES = {
  shillong: 'https://www.meghalayateer.com/shillong-teer-result',
  khanapara: 'https://www.meghalayateer.com/khanapara-teer-result',
  juwai: 'https://www.meghalayateer.com/juwai-teer-result',
  // Add more sources or fallback URLs
};

async function fetchResultFromWeb(game) {
  try {
    // Method 1: Web Scraping (Example - adjust selectors based on actual site)
    const url = RESULT_SOURCES[game];
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Example selectors (MUST be updated based on actual website structure)
    const fr = $('.fr-result').first().text().trim();
    const sr = $('.sr-result').first().text().trim();

    if (fr && sr && /^\d{2}$/.test(fr) && /^\d{2}$/.test(sr)) {
      return { fr, sr };
    }

    return null;
  } catch (error) {
    console.error(`Error fetching ${game} result:`, error.message);
    return null;
  }
}

async function checkAndUpdateResults(game, round, expectedTime) {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Check if result already exists
    let result = await Result.findOne({ game, date: today });
    
    if (!result) {
      result = new Result({ game, date: today });
    }

    // If this round is already declared, skip
    if (round === 'FR' && result.fr) return;
    if (round === 'SR' && result.sr) return;

    // Fetch result from web
    const webResult = await fetchResultFromWeb(game);
    
    if (webResult) {
      if (round === 'FR' && webResult.fr) {
        result.fr = webResult.fr;
        result.frTime = new Date().toLocaleTimeString('en-IN', { hour12: false });
        await result.save();
        
        // Process user bets
        await processUserBets(game, 'FR', webResult.fr, today);
        
        // Broadcast to all connected clients
        io.emit('result-update', {
          game,
          round: 'FR',
          result: webResult.fr,
          date: today
        });
        
        console.log(`✅ ${game} FR result declared: ${webResult.fr}`);
      }
      
      if (round === 'SR' && webResult.sr) {
        result.sr = webResult.sr;
        result.srTime = new Date().toLocaleTimeString('en-IN', { hour12: false });
        await result.save();
        
        await processUserBets(game, 'SR', webResult.sr, today);
        
        io.emit('result-update', {
          game,
          round: 'SR',
          result: webResult.sr,
          date: today
        });
        
        console.log(`✅ ${game} SR result declared: ${webResult.sr}`);
      }
    }
  } catch (error) {
    console.error('Error in checkAndUpdateResults:', error);
  }
}

async function processUserBets(game, round, resultNumber, date) {
  try {
    // Find all active bets for this game/round/date
    const activeBets = await Bet.find({
      game,
      round,
      date,
      status: 'active'
    }).populate('userId');

    for (const bet of activeBets) {
      if (bet.number === resultNumber) {
        // Winner!
        const winAmount = bet.amount * 80; // Single round payout
        bet.status = 'won';
        bet.winAmount = winAmount;
        bet.resultNumber = resultNumber;
        await bet.save();

        // Update user stats
        await User.findByIdAndUpdate(bet.userId._id, {
          $inc: {
            'stats.wonBets': 1,
            'stats.totalWon': winAmount
          }
        });

        // Send real-time notification to user
        io.to(bet.userId._id.toString()).emit('bet-won', {
          betId: bet._id,
          game,
          round,
          number: bet.number,
          amount: bet.amount,
          winAmount
        });

        console.log(`🎉 User ${bet.userId.name} won ₹${winAmount}!`);
      } else {
        // Loser
        bet.status = 'lost';
        bet.resultNumber = resultNumber;
        await bet.save();
      }
    }
  } catch (error) {
    console.error('Error processing user bets:', error);
  }
}

// ==================== CRON JOBS FOR AUTOMATIC RESULT FETCHING ====================

// Shillong Teer - FR at 3:35 PM, SR at 4:35 PM
cron.schedule('35 15 * * *', () => {
  console.log('⏰ Checking Shillong FR result...');
  checkAndUpdateResults('shillong', 'FR', '15:30');
}, {
  timezone: "Asia/Kolkata"
});

cron.schedule('35 16 * * *', () => {
  console.log('⏰ Checking Shillong SR result...');
  checkAndUpdateResults('shillong', 'SR', '16:30');
}, {
  timezone: "Asia/Kolkata"
});

// Khanapara Teer - FR at 3:50 PM, SR at 4:20 PM
cron.schedule('50 15 * * *', () => {
  console.log('⏰ Checking Khanapara FR result...');
  checkAndUpdateResults('khanapara', 'FR', '15:45');
}, {
  timezone: "Asia/Kolkata"
});

cron.schedule('20 16 * * *', () => {
  console.log('⏰ Checking Khanapara SR result...');
  checkAndUpdateResults('khanapara', 'SR', '16:15');
}, {
  timezone: "Asia/Kolkata"
});

// Juwai Teer - FR at 1:50 PM, SR at 2:35 PM
cron.schedule('50 13 * * *', () => {
  console.log('⏰ Checking Juwai FR result...');
  checkAndUpdateResults('juwai', 'FR', '13:45');
}, {
  timezone: "Asia/Kolkata"
});

cron.schedule('35 14 * * *', () => {
  console.log('⏰ Checking Juwai SR result...');
  checkAndUpdateResults('juwai', 'SR', '14:30');
}, {
  timezone: "Asia/Kolkata"
});

// Night Teer - FR at 11:15 PM, SR at 12:15 AM
cron.schedule('15 23 * * *', () => {
  console.log('⏰ Checking Night FR result...');
  checkAndUpdateResults('night', 'FR', '23:10');
}, {
  timezone: "Asia/Kolkata"
});

cron.schedule('15 0 * * *', () => {
  console.log('⏰ Checking Night SR result...');
  checkAndUpdateResults('night', 'SR', '00:10');
}, {
  timezone: "Asia/Kolkata"
});

// ==================== WEBSOCKET CONNECTION ====================

io.on('connection', (socket) => {
  console.log('👤 User connected:', socket.id);

  socket.on('authenticate', (userId) => {
    socket.join(userId);
    console.log(`✅ User ${userId} authenticated`);
  });

  socket.on('disconnect', () => {
    console.log('👋 User disconnected:', socket.id);
  });
});

// ==================== ADMIN ROUTES (Manual Result Entry) ====================

app.post('/api/admin/result', async (req, res) => {
  try {
    // Add authentication check here
    const { game, round, result, date } = req.body;

    let resultDoc = await Result.findOne({ game, date });
    if (!resultDoc) {
      resultDoc = new Result({ game, date });
    }

    if (round === 'FR') {
      resultDoc.fr = result;
      resultDoc.frTime = new Date().toLocaleTimeString('en-IN');
    } else {
      resultDoc.sr = result;
      resultDoc.srTime = new Date().toLocaleTimeString('en-IN');
    }

    await resultDoc.save();
    await processUserBets(game, round, result, date);

    io.emit('result-update', { game, round, result, date });

    res.json({ success: true, result: resultDoc });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🎯 TeerPro Backend Server                                 ║
║                                                              ║
║   Server running on port ${PORT}                               ║
║   Database: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}                                      ║
║   WebSocket: ✅ Active                                       ║
║   Auto-fetch: ✅ Scheduled                                   ║
║                                                              ║
║   API Endpoints:                                            ║
║   POST /api/auth/register                                   ║
║   POST /api/auth/login                                      ║
║   GET  /api/bets                                            ║
║   POST /api/bets                                            ║
║   GET  /api/results/today                                   ║
║   GET  /api/results/history                                 ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
