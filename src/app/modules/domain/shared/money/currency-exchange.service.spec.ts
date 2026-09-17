import {
  FrankfurterClient,
  FrankfurterRate,
} from './clients/frankfurter.client';
import { CurrencyExchangeService } from './currency-exchange.service';
import { InvalidMoneyAmountError } from './exceptions/invalid-money-amount.error';
import { UnsupportedCurrencyError } from './exceptions/unsupported-currency.error';
import { Money } from './money';

describe('CurrencyExchangeService', () => {
  let service: CurrencyExchangeService;
  let frankfurterClient: {
    getRate: jest.Mock<Promise<FrankfurterRate>, [string, string]>;
  };

  beforeEach(() => {
    frankfurterClient = {
      getRate: jest.fn<Promise<FrankfurterRate>, [string, string]>(),
    };
    service = new CurrencyExchangeService(
      frankfurterClient as unknown as FrankfurterClient,
    );
  });

  describe('USD -> USD', () => {
    it('does not call FrankfurterClient', async () => {
      const money: Money = { amount: '100.00', currency: 'USD' };

      await service.convertToUsd(money);

      expect(frankfurterClient.getRate).not.toHaveBeenCalled();
    });

    it('returns a rate of exactly 1 and the same amount', async () => {
      const money: Money = { amount: '1234.56', currency: 'USD' };

      const conversion = await service.convertToUsd(money);

      expect(conversion.rate).toBe('1');
      expect(conversion.converted).toEqual({
        amount: '1234.56',
        currency: 'USD',
      });
      expect(conversion.original).toEqual(money);
      expect(conversion.source).toBe('frankfurter.dev');
    });

    it('is case-insensitive for the currency code', async () => {
      const money: Money = { amount: '10', currency: 'usd' };

      const conversion = await service.convertToUsd(money);

      expect(frankfurterClient.getRate).not.toHaveBeenCalled();
      expect(conversion.rate).toBe('1');
    });
  });

  describe('EUR -> USD', () => {
    it('calls FrankfurterClient with the source and USD', async () => {
      frankfurterClient.getRate.mockResolvedValue({
        from: 'EUR',
        to: 'USD',
        rate: '1.0834',
        rateDate: new Date('2026-01-15T00:00:00.000Z'),
      });

      await service.convertToUsd({ amount: '100.00', currency: 'EUR' });

      expect(frankfurterClient.getRate).toHaveBeenCalledWith('EUR', 'USD');
    });

    it('performs exact decimal conversion with deterministic rounding', async () => {
      frankfurterClient.getRate.mockResolvedValue({
        from: 'EUR',
        to: 'USD',
        rate: '1.0834',
        rateDate: new Date('2026-01-15T00:00:00.000Z'),
      });

      const conversion = await service.convertToUsd({
        amount: '100.00',
        currency: 'EUR',
      });

      expect(conversion.converted).toEqual({
        amount: '108.3400',
        currency: 'USD',
      });
      expect(conversion.rate).toBe('1.0834');
    });

    it('preserves the provider rate date exactly, without substituting today', async () => {
      const rateDate = new Date('2024-03-01T00:00:00.000Z');
      frankfurterClient.getRate.mockResolvedValue({
        from: 'EUR',
        to: 'USD',
        rate: '1.1',
        rateDate,
      });

      const conversion = await service.convertToUsd({
        amount: '10',
        currency: 'EUR',
      });

      expect(conversion.rateDate).toEqual(rateDate);
    });

    it('preserves the original money unchanged', async () => {
      frankfurterClient.getRate.mockResolvedValue({
        from: 'EUR',
        to: 'USD',
        rate: '1.1',
        rateDate: new Date('2026-01-15T00:00:00.000Z'),
      });
      const money: Money = { amount: '100.00', currency: 'EUR' };

      const conversion = await service.convertToUsd(money);

      expect(conversion.original).toEqual(money);
    });
  });

  describe('validation', () => {
    it('rejects an invalid source Money amount without calling FrankfurterClient', async () => {
      await expect(
        service.convertToUsd({ amount: 'not-a-number', currency: 'EUR' }),
      ).rejects.toBeInstanceOf(InvalidMoneyAmountError);
      expect(frankfurterClient.getRate).not.toHaveBeenCalled();
    });

    it('rejects a negative source Money amount', async () => {
      await expect(
        service.convertToUsd({ amount: '-1', currency: 'EUR' }),
      ).rejects.toBeInstanceOf(InvalidMoneyAmountError);
    });

    it('rejects a malformed currency code without calling FrankfurterClient', async () => {
      await expect(
        service.convertToUsd({ amount: '10', currency: 'EU' }),
      ).rejects.toBeInstanceOf(UnsupportedCurrencyError);
      expect(frankfurterClient.getRate).not.toHaveBeenCalled();
    });

    it('propagates an invalid/unavailable FX rate from FrankfurterClient', async () => {
      const error = new UnsupportedCurrencyError('ZZZ');
      frankfurterClient.getRate.mockRejectedValue(error);

      await expect(
        service.convertToUsd({ amount: '10', currency: 'ZZZ' }),
      ).rejects.toBe(error);
    });
  });
});
