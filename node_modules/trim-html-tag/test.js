import { equal } from 'assert';
import trimTag from './index';

it('should trim p tag', () =>
  equal(trimTag('<p> trimP </p>\n'), 'trimP'));

it('should trim h1 tag', () =>
  equal(trimTag('<h1> trimH1 </h1>\n'), 'trimH1'));

it('should trim anything tag', () =>
  equal(trimTag('<h1 class="asd"> trimH1 </h1>\n'), 'trimH1'));

it('should trim only one tag', () =>
  equal(trimTag('<p>stringified <em>stay here</em></p>\n'), 'stringified <em>stay here</em>'));

it('should trim only one tag 2', () =>
  equal(trimTag('<p>stringified <em>stay here</em> <b>asd</b></p>\n'), 'stringified <em>stay here</em> <b>asd</b>'));

it('should trim only one tag 3', () =>
  equal(trimTag('<p>stringified <em>stay <b>asd</b> here</em></p>\n'), 'stringified <em>stay <b>asd</b> here</em>'));

it('should trim tag invalid input', () =>
  equal(trimTag(), undefined));

it('should trim input without tags', () =>
  equal(trimTag('some '), 'some'));
