import { equal } from 'assert';
import getDesc from './index';

const input = `
# title

* nope

Published yesterday

Or in 21 december 2012

True *description*`;

it('should getDesc simple', () =>
  equal(getDesc(input).text, 'Published yesterday'));

it('should getDesc firstMatch', () =>
  equal(getDesc(input, /december/).text, 'Published yesterday'));

it('should getDesc text', () =>
  equal(getDesc(input, /Published|december/).text, 'True description'));

it('should getDesc html', () =>
  equal(getDesc(input, /Published|december/).html, 'True <em>description</em>'));

it('should getDesc undefined', () =>
  equal(getDesc('', /Published|december/), undefined));
