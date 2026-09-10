const express = require('express');
const router = express.Router();
const authCtrl = require('../controllers/authController');
const memberCtrl = require('../controllers/memberController');
const roiCtrl = require('../controllers/roiController');
const dayTradeCtrl = require('../controllers/dayTradeController');
const noticeCtrl = require('../controllers/noticeController');
const withdrawalCtrl = require('../controllers/withdrawalController');
const { adminMiddleware, authMiddleware } = require('../middleware/auth');
const upload = require('../config/upload');
const { uploadAdminSettings } = require('../config/upload');

// Public
router.post('/auth/admin/login', authCtrl.adminLogin);
router.post('/auth/member/login', authCtrl.memberLogin);
router.post('/auth/member/forgot-password', authCtrl.memberForgotPassword);
router.post('/auth/member/reset-password', authCtrl.memberResetPassword);
router.get('/auth/admin-settings', authCtrl.getAdminSettings);
router.get('/auth/packages', authCtrl.getPackages);
router.get('/auth/web3-config', authCtrl.getWeb3Config);
router.get('/auth/sponsor/:code', memberCtrl.lookupSponsor);

// Member registration
router.post('/member/register', upload.fields([{ name: 'aadhaar_photo', maxCount: 1 }]), memberCtrl.register);
router.post('/member/register/send-otp', upload.fields([{ name: 'aadhaar_photo', maxCount: 1 }]), memberCtrl.sendRegistrationOtp);
router.post('/member/register/verify', memberCtrl.verifyRegistrationOtp);
router.post('/member/payment', upload.fields([{ name: 'receipt', maxCount: 1 }]), memberCtrl.submitPayment);
router.post(
  '/member/registration-payment',
  authMiddleware,
  upload.fields([{ name: 'receipt', maxCount: 1 }]),
  memberCtrl.submitPayment
);
router.get('/member/registration-payment/info', authMiddleware, memberCtrl.getRegistrationPaymentInfo);
router.post(
  '/member/trading-wallet/topup',
  authMiddleware,
  upload.fields([{ name: 'receipt', maxCount: 1 }]),
  memberCtrl.submitTradingTopup
);

router.get('/member/plan-topup/info', authMiddleware, memberCtrl.getPlanTopupInfo);
router.post(
  '/member/plan-topup/payment',
  authMiddleware,
  upload.fields([{ name: 'receipt', maxCount: 1 }]),
  memberCtrl.submitPlanTopupPayment
);

// Member protected
router.post(
  '/member/register-downline',
  authMiddleware,
  upload.fields([{ name: 'aadhaar_photo', maxCount: 1 }]),
  memberCtrl.registerDownline,
);
router.post(
  '/member/register-downline/send-otp',
  authMiddleware,
  upload.fields([{ name: 'aadhaar_photo', maxCount: 1 }]),
  memberCtrl.sendDownlineRegistrationOtp,
);
router.post('/member/register-downline/verify', authMiddleware, memberCtrl.verifyDownlineRegistrationOtp);
router.get('/member/dashboard', authMiddleware, memberCtrl.getMemberDashboard);
router.get('/member/genealogy', authMiddleware, memberCtrl.getMemberGenealogy);
router.get('/member/level-business', authMiddleware, memberCtrl.getMemberLevelBusiness);
router.get('/member/transactions', authMiddleware, memberCtrl.getMyTransactions);
router.get('/member/day-trades', authMiddleware, dayTradeCtrl.getDayTradesMember);
router.get('/member/day-trades/my-buys', authMiddleware, memberCtrl.getMyDayTradeInvestments);
router.post('/member/buy-trade', authMiddleware, memberCtrl.buyDayTrade);
router.post('/member/change-password', authMiddleware, memberCtrl.changeMemberPassword);
router.get('/member/notices', authMiddleware, noticeCtrl.listForMembers);
router.get('/member/login-popups', authMiddleware, authCtrl.getMemberLoginPopups);
router.patch('/member/wallet-address', authMiddleware, withdrawalCtrl.updateMemberWalletAddress);
router.post('/member/withdrawals/send-otp', authMiddleware, withdrawalCtrl.sendWithdrawalOtp);
router.post('/member/withdrawals', authMiddleware, withdrawalCtrl.createWithdrawal);
router.get('/member/withdrawals', authMiddleware, withdrawalCtrl.listMyWithdrawals);

// Admin protected
router.get('/admin/stats', adminMiddleware, memberCtrl.getAdminStats);
router.get('/admin/members', adminMiddleware, memberCtrl.getAllMembers);
router.get('/admin/members/:id', adminMiddleware, memberCtrl.getAdminMemberById);
router.put('/admin/members/:id', adminMiddleware, memberCtrl.updateAdminMember);
router.put('/admin/members/:id/password', adminMiddleware, memberCtrl.adminSetMemberPassword);
router.post('/admin/members/:id/impersonate', adminMiddleware, authCtrl.adminImpersonateMember);
router.get('/admin/payments', adminMiddleware, memberCtrl.getAdminPayments);
router.put('/admin/members/:id/status', adminMiddleware, memberCtrl.updateMemberStatus);
router.post('/admin/members/:id/plan-topup', adminMiddleware, memberCtrl.incrementMemberPlanTopup);
router.post(
  '/admin/payments/:paymentId/approve-plan-topup',
  adminMiddleware,
  memberCtrl.approvePlanTopupPayment
);
router.post(
  '/admin/payments/:paymentId/reject-plan-topup',
  adminMiddleware,
  memberCtrl.rejectPlanTopupPayment
);
router.post(
  '/admin/payments/:paymentId/approve-trading-topup',
  adminMiddleware,
  memberCtrl.approveTradingTopupPayment
);
router.post(
  '/admin/payments/:paymentId/reject-trading-topup',
  adminMiddleware,
  memberCtrl.rejectTradingTopupPayment
);
router.put(
  '/admin/settings',
  adminMiddleware,
  uploadAdminSettings.fields([{ name: 'metamask_qr', maxCount: 1 }]),
  authCtrl.updateAdminSettings,
);
router.get('/admin/login-popup', adminMiddleware, authCtrl.getAdminLoginPopup);
router.put(
  '/admin/login-popup/video',
  adminMiddleware,
  uploadAdminSettings.fields([{ name: 'login_popup_video', maxCount: 1 }]),
  authCtrl.updateLoginPopupVideo,
);
router.put(
  '/admin/login-popup/image',
  adminMiddleware,
  uploadAdminSettings.fields([{ name: 'login_popup_image', maxCount: 1 }]),
  authCtrl.updateLoginPopupImage,
);
router.get('/admin/notices', adminMiddleware, noticeCtrl.adminList);
router.post('/admin/notices', adminMiddleware, noticeCtrl.adminCreate);
router.patch('/admin/notices/:id', adminMiddleware, noticeCtrl.adminUpdate);
router.delete('/admin/notices/:id', adminMiddleware, noticeCtrl.adminDelete);
router.get('/admin/withdrawals', adminMiddleware, withdrawalCtrl.adminListWithdrawals);
router.post('/admin/withdrawals/:id/reject', adminMiddleware, withdrawalCtrl.adminRejectWithdrawal);
router.post('/admin/withdrawals/:id/mark-paid', adminMiddleware, withdrawalCtrl.adminMarkWithdrawalPaid);

// Admin: Salary & Reward
router.post('/admin/salary', adminMiddleware, memberCtrl.giveSalary);
router.get('/admin/salaries', adminMiddleware, memberCtrl.getAllSalaries);
router.post('/admin/reward', adminMiddleware, memberCtrl.giveReward);
router.get('/admin/rewards', adminMiddleware, memberCtrl.getAllRewards);

// Admin: Transactions report
router.get('/admin/transactions', adminMiddleware, memberCtrl.getAllTransactions);

// Admin: Trading wallet fund (manual credit by admin)
router.post('/admin/trading-wallet/fund', adminMiddleware, memberCtrl.addTradingWallet);

// ROI Trades
router.post('/admin/roi/create', adminMiddleware, roiCtrl.createRoiTrade);
router.post('/admin/roi/open', adminMiddleware, roiCtrl.openRoiTrade);
router.post('/admin/roi/close/:trade_id', adminMiddleware, roiCtrl.closeRoiTrade);
router.post('/admin/roi/:trade_id/distribute-slot/:slot', adminMiddleware, roiCtrl.distributeRoiSlot);
router.put('/admin/roi/today', adminMiddleware, roiCtrl.updateTodayRoiTrade);
router.patch('/admin/roi/today/slot/:slot', adminMiddleware, roiCtrl.updateTodayRoiSlot);
router.put('/admin/roi/today/slot/:slot', adminMiddleware, roiCtrl.updateTodayRoiSlot);
router.get('/admin/roi/trades', adminMiddleware, roiCtrl.getRoiTrades);
router.get('/admin/roi/today', adminMiddleware, roiCtrl.getTodayRoiTrade);
router.get('/admin/roi/reports/day', adminMiddleware, roiCtrl.getAdminRoiReportByDay);
router.get('/admin/roi/reports/monthly', adminMiddleware, roiCtrl.getAdminRoiReportMonthly);
router.get('/admin/roi/:id/report', adminMiddleware, roiCtrl.getRoiDistributionReport);
router.get('/member/roi/today', authMiddleware, roiCtrl.getTodayRoiTrade);
router.get('/member/roi/status', authMiddleware, roiCtrl.getMemberRoiStatus);
router.get('/member/roi/participation', authMiddleware, roiCtrl.getMemberRoiParticipation);
router.post('/member/roi/join', authMiddleware, roiCtrl.joinRoiTrade);

// Day Trades
router.post('/admin/day-trades', adminMiddleware, dayTradeCtrl.createDayTrade);
router.put('/admin/day-trades/:id', adminMiddleware, dayTradeCtrl.updateDayTrade);
router.delete('/admin/day-trades/:id', adminMiddleware, dayTradeCtrl.deleteDayTrade);
router.put('/admin/day-trades/:id/activate', adminMiddleware, dayTradeCtrl.activateDayTrade);
router.put('/admin/day-trades/:id/deactivate', adminMiddleware, dayTradeCtrl.deactivateDayTrade);
router.post('/admin/day-trades/settle', adminMiddleware, dayTradeCtrl.settleDayTrades);
router.get('/admin/day-trades', adminMiddleware, dayTradeCtrl.getDayTradesAdmin);
router.get('/admin/day-trades/:id/investors', adminMiddleware, dayTradeCtrl.getTradeInvestors);

module.exports = router;
