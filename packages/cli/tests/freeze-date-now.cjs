const FIXED_NOW = 1791000000000;
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) {
    super(...(args.length === 0 ? [FIXED_NOW] : args));
  }
  static now() {
    return FIXED_NOW;
  }
}
global.Date = FrozenDate;
