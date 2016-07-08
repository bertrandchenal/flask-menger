from collections import defaultdict
from itertools import groupby, product, takewhile, dropwhile, cycle
from tempfile import mkdtemp
import logging
import os

import numpy
from menger import Dimension, Measure, get_space, gasket

DEFAULT_LIMIT = 10**5

logger = logging.getLogger('menger.flask')
not_none = lambda x: x is not None
is_none = lambda x: x is None

class LimitException(Exception):
    pass


def dice(coordinates, measures, **options):
    select = ['%s[%s]'% (d, len(v) - 1) for d, v in coordinates]
    select = select + measures

    filters = []
    for name, vals in coordinates:
        filters.append((
            name,
            [tuple(takewhile(lambda x: x is not None, vals))]
        ))
    query = {
        'select': select,
        'format': 'leaf',
        'filters': filters + options.get('filters', []),
        'skip_zero': options.get('skip_zero'),
        'msr_fmt': options.get('msr_fmt'),
        'limit': options.get('limit'),
        'pivot_on': options.get('pivot_on'),
        'sort_by': options.get('sort_by'),
    }

    res = gasket.dice(query)
    data = [list(row) for row in res['data'].values]
    for pos, line in enumerate(data):
        line = [int(x) if isinstance(x, numpy.int64) else x for x in line]
        data[pos] = line
    return {
        'data': data,
        'headers': res['headers'],
        'totals': res['totals'],
    }


def build_xlsx(res):
    import openpyxl
    wb = openpyxl.Workbook(optimized_write=True)
    headers = res['headers']
    wb = openpyxl.Workbook()
    sheet = wb.active
    sheet.title = 'Results'
    print(res)
    for line in headers:
        sheet.append(line)

    for line in res['data']:
        sheet.append(line)

    out = os.path.join(mkdtemp(), 'result.xlsx')
    wb.save(out)
    return out
