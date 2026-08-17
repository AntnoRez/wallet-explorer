/**
 * Маршруты API.
 *
 * Сеть — часть пути, а не параметр строки запроса: адрес существует только
 * в контексте сети, и /api/wallet/tron/TR7NH... честнее описывает ресурс,
 * чем /api/wallet/TR7NH...?network=tron
 */

import { Router } from 'express';
import {
  getWallet,
  getWalletBalance,
  getTransfers,
  getNetworks,
  postLabels,
} from '../controllers/walletController.js';

export const router = Router();

router.get('/networks', getNetworks);

// Метки — POST, потому что список адресов не помещается в строку запроса
router.post('/labels/:network', postLabels);

// Порядок важен: более специфичный путь объявляется раньше, иначе
// /transfers будет проглочен предыдущим маршрутом как часть адреса
router.get('/wallet/:network/:address/transfers', getTransfers);
router.get('/wallet/:network/:address/balance', getWalletBalance);
router.get('/wallet/:network/:address', getWallet);

export default router;
